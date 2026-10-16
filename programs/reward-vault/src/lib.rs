use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("3xUJqsjCQBfvUhEvz5cd16SSAwLdQUFGijoh3X5pLYPZ");

// Fixed-point precision for reward-per-share accounting (Synthetix/MasterChef pattern)
pub const ACC_PRECISION: u128 = 1_000_000_000_000; // 1e12

#[program]
pub mod reward_vault {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.stake_mint = ctx.accounts.stake_mint.key();
        pool.total_staked = 0;
        pool.acc_reward_per_share = 0;
        pool.unallocated_fees = 0;
        pool.vault_sol_bump = ctx.bumps.vault_sol;
        pool.bump = ctx.bumps.pool;
        Ok(())
    }

    /// Permissionless repair path for pools created before `vault_sol` was
    /// rent-funded during pool initialization. It creates the exact PDA used
    /// to receive SOL trading fees; no pool accounting or authority changes.
    pub fn initialize_sol_vault(_ctx: Context<InitializeSolVault>) -> Result<()> {
        Ok(())
    }

    /// Called via CPI from launchpad-core (or any authorized fee source) each
    /// time trading fees are collected. Bumps acc_reward_per_share so every
    /// staker's pending reward grows proportionally without a per-user loop.
    pub fn deposit_fees(ctx: Context<DepositFees>, amount: u64) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        if pool.total_staked > 0 {
            // Sweep any fees that arrived before the first staker alongside this deposit
            let total = (pool.unallocated_fees as u128)
                .checked_add(amount as u128)
                .unwrap();
            let delta = total
                .checked_mul(ACC_PRECISION)
                .unwrap()
                .checked_div(pool.total_staked as u128)
                .unwrap();
            pool.acc_reward_per_share = pool.acc_reward_per_share.checked_add(delta).unwrap();
            pool.unallocated_fees = 0;
        } else {
            // No stakers yet — park fees here; they will be swept on the next
            // deposit_fees call that arrives after someone has staked, so no SOL
            // is permanently stranded.
            pool.unallocated_fees = pool.unallocated_fees.checked_add(amount).unwrap();
        }
        pool.total_fees_collected = pool.total_fees_collected.checked_add(amount).unwrap();
        Ok(())
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, RewardVaultError::ZeroAmount);
        let (pending, mint_key, vault_bump) = pending_reward(&ctx.accounts.pool, &ctx.accounts.user_stake)?;
        if pending > 0 {
            transfer_reward(
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.vault_sol.to_account_info(),
                ctx.accounts.owner.to_account_info(),
                mint_key,
                vault_bump,
                pending,
            )?;
        }
        let pool = &mut ctx.accounts.pool;
        let user = &mut ctx.accounts.user_stake;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.stake_vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        let was_empty = pool.total_staked == 0;
        user.amount = user.amount.checked_add(amount).unwrap();
        pool.total_staked = pool.total_staked.checked_add(amount).unwrap();

        // A fee can arrive before anyone has staked.  Once the first stake is
        // made, make that parked balance claimable immediately rather than
        // requiring a subsequent trade to trigger another deposit_fees call.
        // Set debt against the pre-sweep accumulator so this new stake receives
        // the parked fees, while it never receives rewards accrued before it
        // existed in a non-empty pool.
        user.reward_debt = (user.amount as u128)
            .checked_mul(pool.acc_reward_per_share)
            .unwrap()
            .checked_div(ACC_PRECISION)
            .unwrap();
        if was_empty && pool.unallocated_fees > 0 {
            let delta = (pool.unallocated_fees as u128)
                .checked_mul(ACC_PRECISION)
                .unwrap()
                .checked_div(pool.total_staked as u128)
                .unwrap();
            pool.acc_reward_per_share = pool.acc_reward_per_share.checked_add(delta).unwrap();
            pool.unallocated_fees = 0;
        }
        Ok(())
    }

    pub fn unstake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(ctx.accounts.user_stake.amount >= amount, RewardVaultError::InsufficientStake);
        let (pending, mint_key, vault_bump) = pending_reward(&ctx.accounts.pool, &ctx.accounts.user_stake)?;
        if pending > 0 {
            transfer_reward(
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.vault_sol.to_account_info(),
                ctx.accounts.owner.to_account_info(),
                mint_key,
                vault_bump,
                pending,
            )?;
        }
        let pool_account_info = ctx.accounts.pool.to_account_info();
        let pool = &mut ctx.accounts.pool;
        let user = &mut ctx.accounts.user_stake;

        let mint_key = pool.stake_mint;
        let pool_bump = pool.bump;
        let seeds = &[b"pool", mint_key.as_ref(), &[pool_bump]];
        let signer = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.stake_vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: pool_account_info,
                },
                signer,
            ),
            amount,
        )?;

        user.amount = user.amount.checked_sub(amount).unwrap();
        user.reward_debt = (user.amount as u128).checked_mul(pool.acc_reward_per_share).unwrap().checked_div(ACC_PRECISION).unwrap();
        pool.total_staked = pool.total_staked.checked_sub(amount).unwrap();
        Ok(())
    }

    /// Pays out accrued SOL rewards to the staker. No cron job, no daily
    /// push transaction — the holder just calls this whenever they want.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let (pending, mint_key, vault_bump) = pending_reward(&ctx.accounts.pool, &ctx.accounts.user_stake)?;
        require!(pending > 0, RewardVaultError::NothingToClaim);
        transfer_reward(
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.vault_sol.to_account_info(),
            ctx.accounts.owner.to_account_info(),
            mint_key,
            vault_bump,
            pending,
        )?;
        let pool = &ctx.accounts.pool;
        let user = &mut ctx.accounts.user_stake;
        user.reward_debt = (user.amount as u128).checked_mul(pool.acc_reward_per_share).unwrap().checked_div(ACC_PRECISION).unwrap();
        emit!(RewardClaimed { user: ctx.accounts.owner.key(), amount: pending });
        Ok(())
    }
}

fn pending_reward(pool: &Account<Pool>, user: &Account<UserStake>) -> Result<(u64, Pubkey, u8)> {
    let accrued = (user.amount as u128).checked_mul(pool.acc_reward_per_share).ok_or(RewardVaultError::MathOverflow)?.checked_div(ACC_PRECISION).ok_or(RewardVaultError::MathOverflow)?;
    let pending = accrued.checked_sub(user.reward_debt).unwrap_or(0);
    Ok((u64::try_from(pending).map_err(|_| error!(RewardVaultError::MathOverflow))?, pool.stake_mint, pool.vault_sol_bump))
}

fn transfer_reward<'info>(system_program: AccountInfo<'info>, vault_sol: AccountInfo<'info>, owner: AccountInfo<'info>, stake_mint: Pubkey, vault_bump: u8, amount: u64) -> Result<()> {
    let seeds = &[b"vault_sol", stake_mint.as_ref(), &[vault_bump]];
    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(system_program, anchor_lang::system_program::Transfer { from: vault_sol, to: owner }, &[seeds]),
        amount,
    )
}

#[account]
pub struct Pool {
    pub stake_mint: Pubkey,
    pub total_staked: u64,
    pub acc_reward_per_share: u128,
    pub total_fees_collected: u64,
    pub unallocated_fees: u64, // fees received while total_staked == 0; swept by the first stake
    pub vault_sol_bump: u8,
    pub bump: u8,
}
impl Pool {
    pub const LEN: usize = 8 + 32 + 8 + 16 + 8 + 8 + 1 + 1; // +8 for unallocated_fees
}

#[account]
pub struct UserStake {
    pub owner: Pubkey,
    pub amount: u64,
    pub reward_debt: u128,
}
impl UserStake {
    pub const LEN: usize = 8 + 32 + 8 + 16;
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub stake_mint: Account<'info, Mint>,
    #[account(init, payer = payer, space = Pool::LEN, seeds = [b"pool", stake_mint.key().as_ref()], bump)]
    pub pool: Account<'info, Pool>,
    /// CHECK: zero-data System Program PDA used only as the SOL reward vault.
    #[account(init, payer = payer, space = 0, seeds = [b"vault_sol", stake_mint.key().as_ref()], bump, owner = system_program::ID)]
    pub vault_sol: UncheckedAccount<'info>,
    #[account(init, payer = payer, token::mint = stake_mint, token::authority = pool)]
    pub stake_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitializeSolVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"pool", pool.stake_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    /// CHECK: zero-data System Program PDA, checked as SystemAccount by fee
    /// deposit and claim instructions after it is initialized.
    #[account(init, payer = payer, space = 0, seeds = [b"vault_sol", pool.stake_mint.as_ref()], bump, owner = system_program::ID)]
    pub vault_sol: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositFees<'info> {
    #[account(mut)]
    pub pool: Account<'info, Pool>,
    /// CHECK: lamports are transferred by the caller before this CPI runs;
    /// this instruction only updates accounting.
    #[account(mut)]
    pub vault_sol: SystemAccount<'info>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"pool", pool.stake_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(init_if_needed, payer = owner, space = UserStake::LEN, seeds = [b"user", pool.key().as_ref(), owner.key().as_ref()], bump)]
    pub user_stake: Account<'info, UserStake>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub stake_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault_sol", pool.stake_mint.as_ref()], bump = pool.vault_sol_bump)]
    pub vault_sol: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"pool", pool.stake_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [b"user", pool.key().as_ref(), owner.key().as_ref()], bump)]
    pub user_stake: Account<'info, UserStake>,
    #[account(mut, seeds = [b"vault_sol", pool.stake_mint.as_ref()], bump = pool.vault_sol_bump)]
    pub vault_sol: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct RewardClaimed {
    pub user: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum RewardVaultError {
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("insufficient staked balance")]
    InsufficientStake,
    #[msg("nothing to claim")]
    NothingToClaim,
    #[msg("reward math overflow")]
    MathOverflow,
}
