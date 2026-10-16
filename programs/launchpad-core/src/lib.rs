use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke_signed};
use anchor_spl::token::{self, Mint, Token, TokenAccount, MintTo, Transfer, Burn};
use anchor_spl::token::spl_token::native_mint;
use reward_vault::cpi::accounts::DepositFees;
use reward_vault::program::RewardVault as RewardVaultProgram;
use reward_vault::cpi::deposit_fees;
use merkle_distributor::Distributor;

mod raydium_cpmm;

declare_id!("HbYcvC9n5ZhE1LhVzpmRWLfBVg7oimsDaY7e2Rz8K2Mn");

// ---- Tunables ----
pub const TOTAL_SUPPLY: u64 = 1_000_000_000 * 10u64.pow(6); // 1B tokens, 6 decimals
pub const CURVE_VIRTUAL_SOL: u64 = 30 * 1_000_000_000; // 30 SOL virtual reserve (pump.fun-style)
pub const MIGRATION_SOL_THRESHOLD: u64 = 85_000_000_000; // 85 SOL real reserve triggers migration
pub const TRADE_FEE_BPS: u64 = 100; // 1% fee per trade
pub const FEE_SHARE_TO_STAKERS_BPS: u64 = 2_500; // 25% of the fee -> LAUNCHPAD stakers
pub const FEE_SHARE_TO_TREASURY_BPS: u64 = 7_500; // remaining 75% -> treasury / LP bootstrap
pub const MIN_AIRDROP_BPS: u64 = 100; // 1%
pub const MAX_AIRDROP_BPS: u64 = 500; // 5%

#[program]
pub mod launchpad_core {
    use super::*;

    /// Creates a new memecoin with a bonding curve. `airdrop_bps` (100-500) of
    /// total supply is set aside in a program-controlled reserve that can
    /// later be distributed to holders by the merkle-distributor program,
    /// snapshot-by-snapshot, off-chain-computed / on-chain-verified.
    pub fn create_launch(
        ctx: Context<CreateLaunch>,
        name: String,
        symbol: String,
        uri: String,
        airdrop_bps: u16,
    ) -> Result<()> {
        require!(
            (MIN_AIRDROP_BPS as u16..=MAX_AIRDROP_BPS as u16).contains(&airdrop_bps),
            LaunchpadError::InvalidAirdropBps
        );
        require!(name.len() <= 32 && symbol.len() <= 10 && uri.len() <= 200, LaunchpadError::MetadataTooLong);

        let curve = &mut ctx.accounts.curve;
        curve.mint = ctx.accounts.mint.key();
        curve.creator = ctx.accounts.creator.key();
        // Retained for backwards-compatible Curve account layout. Migration is
        // permissionless; the creator remains recorded separately in `creator`.
        curve.authority = ctx.accounts.creator.key();
        curve.real_sol_reserves = 0;
        curve.airdrop_bps = airdrop_bps;
        curve.migrated = false;
        curve.bump = ctx.bumps.curve;
        curve.curve_authority_bump = ctx.bumps.curve_authority;

        let metadata = &mut ctx.accounts.metadata;
        metadata.mint = ctx.accounts.mint.key();
        metadata.creator = ctx.accounts.creator.key();
        metadata.name = name;
        metadata.symbol = symbol;
        metadata.uri = uri;
        metadata.bump = ctx.bumps.metadata;

        let airdrop_amount = TOTAL_SUPPLY
            .checked_mul(airdrop_bps as u64)
            .unwrap()
            .checked_div(10_000)
            .unwrap();
        let sellable_amount = TOTAL_SUPPLY.checked_sub(airdrop_amount).unwrap();
        curve.real_token_reserves = sellable_amount;
        // Virtual reserves seed the constant-product curve. virtual_token_reserves
        // starts equal to the sellable supply; CURVE_VIRTUAL_SOL is the "phantom"
        // SOL that sets the starting price without needing real SOL locked up
        // (classic pump.fun-style bootstrap). Both fields are then mutated in
        // lockstep with real reserves on every buy/sell.
        curve.virtual_sol_reserves = CURVE_VIRTUAL_SOL;
        curve.virtual_token_reserves = sellable_amount;

        let seeds = &[b"curve_authority", curve.mint.as_ref(), &[curve.curve_authority_bump]];
        let signer = &[&seeds[..]];

        // Mint sellable supply into the curve's own token vault
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.curve_token_vault.to_account_info(),
                    authority: ctx.accounts.curve_authority.to_account_info(),
                },
                signer,
            ),
            sellable_amount,
        )?;

        // Mint the holder-airdrop reserve into a vault the merkle-distributor program controls
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.airdrop_vault.to_account_info(),
                    authority: ctx.accounts.curve_authority.to_account_info(),
                },
                signer,
            ),
            airdrop_amount,
        )?;

        emit!(LaunchCreated {
            mint: curve.mint,
            creator: curve.creator,
            airdrop_bps,
            airdrop_amount,
            sellable_amount,
        });
        Ok(())
    }

    /// Stores the display metadata separately from the Curve account.  Keeping
    /// this in its own PDA means existing Curve accounts remain byte-for-byte
    /// compatible and creators can backfill launches made before metadata was
    /// persisted.
    pub fn set_launch_metadata(
        ctx: Context<SetLaunchMetadata>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        require!(
            name.len() <= 32 && symbol.len() <= 10 && uri.len() <= 200,
            LaunchpadError::MetadataTooLong
        );

        let metadata = &mut ctx.accounts.metadata;
        metadata.mint = ctx.accounts.curve.mint;
        metadata.creator = ctx.accounts.creator.key();
        metadata.name = name;
        metadata.symbol = symbol;
        metadata.uri = uri;
        metadata.bump = ctx.bumps.metadata;
        Ok(())
    }

    /// Creates the rent-exempt system account that holds a launch's SOL
    /// reserves. This is retained as a permissionless one-time initializer so
    /// launches made before the treasury was initialized in `create_launch`
    /// can be repaired without changing any curve state.
    pub fn initialize_curve_treasury(_ctx: Context<InitializeCurveTreasury>) -> Result<()> {
        Ok(())
    }

    /// Funds an already-created Merkle claim epoch from the launch's immutable
    /// airdrop reserve. Only the launch creator may select an epoch to fund,
    /// but the transfer itself is signed exclusively by the airdrop PDA.
    pub fn fund_distributor(ctx: Context<FundDistributor>, amount: u64) -> Result<()> {
        require!(amount > 0, LaunchpadError::ZeroAmount);
        require_keys_eq!(ctx.accounts.distributor.mint, ctx.accounts.curve.mint, LaunchpadError::InvalidDistributor);

        let funded_or_claimed = ctx.accounts.epoch_vault.amount
            .checked_add(ctx.accounts.distributor.claimed_amount)
            .ok_or(LaunchpadError::MathOverflow)?;
        require!(
            funded_or_claimed.checked_add(amount).ok_or(LaunchpadError::MathOverflow)? <= ctx.accounts.distributor.total_amount,
            LaunchpadError::DistributorOverfunded
        );

        let mint_key = ctx.accounts.curve.mint;
        let seeds = &[b"airdrop_authority", mint_key.as_ref(), &[ctx.bumps.airdrop_authority]];
        let signer = &[&seeds[..]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.airdrop_vault.to_account_info(),
                    to: ctx.accounts.epoch_vault.to_account_info(),
                    authority: ctx.accounts.airdrop_authority.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
        Ok(())
    }

    /// Buy tokens off the curve with SOL. Applies TRADE_FEE_BPS; 25% of that
    /// fee is routed via CPI into the staking reward vault for LAUNCHPAD
    /// holders, the rest stays in the curve's treasury for LP bootstrap.
    pub fn buy(ctx: Context<Trade>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        let curve = &mut ctx.accounts.curve;
        require!(!curve.migrated, LaunchpadError::AlreadyMigrated);
        require!(sol_in > 0, LaunchpadError::ZeroAmount);

        let fee = sol_in.checked_mul(TRADE_FEE_BPS).ok_or(LaunchpadError::MathOverflow)?
            .checked_div(10_000).ok_or(LaunchpadError::MathOverflow)?;
        let sol_after_fee = sol_in.checked_sub(fee).ok_or(LaunchpadError::MathOverflow)?;

        // virtual_sol_reserves / virtual_token_reserves ARE the live curve
        // state (pump.fun-style): they start with a virtual offset and move
        // by the exact traded amounts on every buy/sell.
        let vsol = curve.virtual_sol_reserves;
        let vtok = curve.virtual_token_reserves;

        // constant product: tokens_out = vtok - (vsol * vtok) / (vsol + sol_after_fee)
        let k = (vsol as u128).checked_mul(vtok as u128).ok_or(LaunchpadError::MathOverflow)?;
        let new_vsol = (vsol as u128).checked_add(sol_after_fee as u128).ok_or(LaunchpadError::MathOverflow)?;
        let new_vtok = k.checked_div(new_vsol).ok_or(LaunchpadError::MathOverflow)?;
        let tokens_out = u64::try_from((vtok as u128).checked_sub(new_vtok).ok_or(LaunchpadError::MathOverflow)?)
            .map_err(|_| error!(LaunchpadError::MathOverflow))?;

        require!(tokens_out >= min_tokens_out, LaunchpadError::SlippageExceeded);
        require!(tokens_out <= curve.real_token_reserves, LaunchpadError::InsufficientLiquidity);

        // Move SOL: buyer -> curve treasury (lamports)
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.curve_treasury.to_account_info(),
                },
            ),
            sol_after_fee,
        )?;

        // Route the fee: 25% to stakers via CPI, rest to treasury
        let staker_share = fee.checked_mul(FEE_SHARE_TO_STAKERS_BPS).ok_or(LaunchpadError::MathOverflow)?
            .checked_div(10_000).ok_or(LaunchpadError::MathOverflow)?;
        let treasury_share = fee.checked_sub(staker_share).ok_or(LaunchpadError::MathOverflow)?;

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.curve_treasury.to_account_info(),
                },
            ),
            treasury_share,
        )?;

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.reward_vault_sol.to_account_info(),
                },
            ),
            staker_share,
        )?;

        deposit_fees(
            CpiContext::new(
                ctx.accounts.reward_vault_program.to_account_info(),
                DepositFees {
                    pool: ctx.accounts.reward_vault_pool.to_account_info(),
                    vault_sol: ctx.accounts.reward_vault_sol.to_account_info(),
                },
            ),
            staker_share,
        )?;

        // Move tokens: curve vault -> buyer
        let mint_key = curve.mint;
        let seeds = &[b"curve_authority", mint_key.as_ref(), &[curve.curve_authority_bump]];
        let signer = &[&seeds[..]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.curve_token_vault.to_account_info(),
                    to: ctx.accounts.buyer_token_account.to_account_info(),
                    authority: ctx.accounts.curve_authority.to_account_info(),
                },
                signer,
            ),
            tokens_out,
        )?;

        curve.real_sol_reserves = curve.real_sol_reserves.checked_add(sol_after_fee).ok_or(LaunchpadError::MathOverflow)?;
        curve.real_token_reserves = curve.real_token_reserves.checked_sub(tokens_out).ok_or(LaunchpadError::MathOverflow)?;
        curve.virtual_sol_reserves = u64::try_from(new_vsol).map_err(|_| error!(LaunchpadError::MathOverflow))?;
        curve.virtual_token_reserves = u64::try_from(new_vtok).map_err(|_| error!(LaunchpadError::MathOverflow))?;

        emit!(TradeExecuted { mint: mint_key, buyer: ctx.accounts.buyer.key(), is_buy: true, sol_amount: sol_in, token_amount: tokens_out, fee });

        if curve.real_sol_reserves >= MIGRATION_SOL_THRESHOLD {
            curve.ready_to_migrate = true;
        }
        Ok(())
    }

    /// Sell tokens back into the curve for SOL. Same fee split as buy.
    pub fn sell(ctx: Context<Trade>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        let curve = &mut ctx.accounts.curve;
        require!(!curve.migrated, LaunchpadError::AlreadyMigrated);
        require!(tokens_in > 0, LaunchpadError::ZeroAmount);

        let vsol = curve.virtual_sol_reserves;
        let vtok = curve.virtual_token_reserves;

        let k = (vsol as u128).checked_mul(vtok as u128).ok_or(LaunchpadError::MathOverflow)?;
        let new_vtok = (vtok as u128).checked_add(tokens_in as u128).ok_or(LaunchpadError::MathOverflow)?;
        let new_vsol = k.checked_div(new_vtok).ok_or(LaunchpadError::MathOverflow)?;
        let sol_out_gross = u64::try_from((vsol as u128).checked_sub(new_vsol).ok_or(LaunchpadError::MathOverflow)?)
            .map_err(|_| error!(LaunchpadError::MathOverflow))?;

        let fee = sol_out_gross.checked_mul(TRADE_FEE_BPS).ok_or(LaunchpadError::MathOverflow)?
            .checked_div(10_000).ok_or(LaunchpadError::MathOverflow)?;
        let sol_out_net = sol_out_gross.checked_sub(fee).ok_or(LaunchpadError::MathOverflow)?;
        require!(sol_out_net >= min_sol_out, LaunchpadError::SlippageExceeded);
        require!(sol_out_gross <= curve.real_sol_reserves, LaunchpadError::InsufficientLiquidity);

        // tokens: seller -> curve vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_token_account.to_account_info(),
                    to: ctx.accounts.curve_token_vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            tokens_in,
        )?;

        let mint_key = curve.mint;

        let staker_share = fee.checked_mul(FEE_SHARE_TO_STAKERS_BPS).ok_or(LaunchpadError::MathOverflow)?
            .checked_div(10_000).ok_or(LaunchpadError::MathOverflow)?;
        // The treasury is a System-owned PDA. Its lamports must be moved by
        // the System Program with the PDA's seeds, rather than modified by
        // this program directly. The treasury's 75% share never leaves it;
        // only the seller net and staker share are transferred out.
        let treasury_seeds = &[
            b"treasury",
            mint_key.as_ref(),
            &[ctx.bumps.curve_treasury],
        ];
        let treasury_signer = &[&treasury_seeds[..]];

        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.curve_treasury.to_account_info(),
                    to: ctx.accounts.buyer.to_account_info(),
                },
                treasury_signer,
            ),
            sol_out_net,
        )?;
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.curve_treasury.to_account_info(),
                    to: ctx.accounts.reward_vault_sol.to_account_info(),
                },
                treasury_signer,
            ),
            staker_share,
        )?;

        deposit_fees(
            CpiContext::new(
                ctx.accounts.reward_vault_program.to_account_info(),
                DepositFees {
                    pool: ctx.accounts.reward_vault_pool.to_account_info(),
                    vault_sol: ctx.accounts.reward_vault_sol.to_account_info(),
                },
            ),
            staker_share,
        )?;

        curve.real_sol_reserves = curve.real_sol_reserves.checked_sub(sol_out_gross).ok_or(LaunchpadError::MathOverflow)?;
        curve.real_token_reserves = curve.real_token_reserves.checked_add(tokens_in).ok_or(LaunchpadError::MathOverflow)?;
        curve.virtual_sol_reserves = u64::try_from(new_vsol).map_err(|_| error!(LaunchpadError::MathOverflow))?;
        curve.virtual_token_reserves = u64::try_from(new_vtok).map_err(|_| error!(LaunchpadError::MathOverflow))?;

        emit!(TradeExecuted { mint: mint_key, buyer: ctx.accounts.buyer.key(), is_buy: false, sol_amount: sol_out_net, token_amount: tokens_in, fee });
        Ok(())
    }

    /// Atomically migrates a completed bonding curve to a Raydium CPMM pool:
    /// 1. Validate curve state (ready and not migrated).
    /// 2. Transfer treasury SOL into the curve_authority WSOL ATA + sync_native.
    /// 3. Sort the token pair (token-0 < token-1 by pubkey) per Raydium invariant.
    /// 4. CPI to Raydium CPMM `initialize` with curve_authority as "creator".
    /// 5. Burn all received LP tokens (no LP remains in anyone's hands).
    /// 6. Mark curve.migrated = true and emit event.
    /// `pool_funding` is a temporary budget for Raydium's create-pool fee and
    /// account rent. It comes from the curve treasury's accumulated fee share,
    /// never from the caller. Any unused amount returns to that treasury.
    pub fn mark_migrated(ctx: Context<Migrate>, pool_funding: u64) -> Result<()> {
        // Validate program ID before anything else
        require!(
            raydium_cpmm::is_valid_cpmm_program(ctx.accounts.raydium_cpmm_program.key),
            LaunchpadError::InvalidRaydiumProgram
        );

        // Extract fields we need before mutably borrowing curve
        let (mint_key, auth_bump, sol_reserves, token_reserves) = {
            let curve = &ctx.accounts.curve;
            require!(curve.ready_to_migrate, LaunchpadError::NotReadyToMigrate);
            require!(!curve.migrated, LaunchpadError::AlreadyMigrated);
            (curve.mint, curve.curve_authority_bump, curve.real_sol_reserves, curve.real_token_reserves)
        };

        let curve_authority_seeds: &[&[u8]] = &[
            b"curve_authority",
            mint_key.as_ref(),
            &[auth_bump],
        ];

        // Raydium treats curve_authority as its pool creator and payer. The
        // curve's fee surplus pays this temporary budget, so migration is
        // permissionless. Keep the tracked SOL reserves intact for liquidity.
        require!(pool_funding > 0, LaunchpadError::ZeroAmount);
        let required_treasury_balance = sol_reserves
            .checked_add(pool_funding)
            .ok_or(LaunchpadError::MathOverflow)?;
        require!(
            ctx.accounts.curve_treasury.lamports() >= required_treasury_balance,
            LaunchpadError::InsufficientMigrationFunding
        );
        transfer_from_curve_treasury(
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.curve_treasury.to_account_info(),
            ctx.accounts.curve_authority.to_account_info(),
            mint_key,
            ctx.bumps.curve_treasury,
            pool_funding,
        )?;

        // ── Step 1: Wrap treasury SOL → WSOL ATA ──
        // Move lamports from treasury PDA to the WSOL ATA directly (BPF-safe),
        // then call sync_native so the SPL token balance reflects the lamports.
        transfer_from_curve_treasury(
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.curve_treasury.to_account_info(),
            ctx.accounts.curve_authority_wsol.to_account_info(),
            mint_key,
            ctx.bumps.curve_treasury,
            sol_reserves,
        )?;

        // sync_native instruction tag = 17u8, no additional data, no signer
        {
            let sync_ix = Instruction {
                program_id: *ctx.accounts.token_program.key,
                accounts: vec![AccountMeta::new(ctx.accounts.curve_authority_wsol.key(), false)],
                data: vec![17u8],
            };
            invoke_signed(
                &sync_ix,
                &[
                    ctx.accounts.curve_authority_wsol.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                ],
                &[curve_authority_seeds],
            )?;
        }

        // ── Step 2: Determine token-0 / token-1 ordering ──
        // Raydium requires token_0_mint.key() < token_1_mint.key() lexicographically.
        let memecoin_key = ctx.accounts.memecoin_mint.key();
        let wsol_key = ctx.accounts.wsol_mint.key();

        let (token_0_mint_info, token_1_mint_info,
             creator_token_0_info, creator_token_1_info,
             init_amount_0, init_amount_1) =
        if memecoin_key < wsol_key {
            // memecoin is token-0, WSOL is token-1
            (
                ctx.accounts.memecoin_mint.to_account_info(),
                ctx.accounts.wsol_mint.to_account_info(),
                ctx.accounts.curve_token_vault.to_account_info(),
                ctx.accounts.curve_authority_wsol.to_account_info(),
                token_reserves,
                sol_reserves,
            )
        } else {
            // WSOL is token-0, memecoin is token-1
            (
                ctx.accounts.wsol_mint.to_account_info(),
                ctx.accounts.memecoin_mint.to_account_info(),
                ctx.accounts.curve_authority_wsol.to_account_info(),
                ctx.accounts.curve_token_vault.to_account_info(),
                sol_reserves,
                token_reserves,
            )
        };

        // ── Step 3: CPI to Raydium CPMM initialize ──
        raydium_cpmm::cpi_initialize(
            &ctx.accounts.raydium_cpmm_program.to_account_info(),
            &ctx.accounts.curve_authority.to_account_info(),  // creator = curve_authority PDA
            &ctx.accounts.amm_config.to_account_info(),
            &ctx.accounts.raydium_authority.to_account_info(),
            &ctx.accounts.pool_state.to_account_info(),
            &token_0_mint_info,
            &token_1_mint_info,
            &ctx.accounts.lp_mint.to_account_info(),
            &creator_token_0_info,
            &creator_token_1_info,
            &ctx.accounts.creator_lp_token.to_account_info(),
            &ctx.accounts.token_0_vault.to_account_info(),
            &ctx.accounts.token_1_vault.to_account_info(),
            &ctx.accounts.create_pool_fee.to_account_info(),
            &ctx.accounts.observation_state.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),  // token_0_program (SPL)
            &ctx.accounts.token_program.to_account_info(),  // token_1_program (SPL)
            &ctx.accounts.associated_token_program.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.rent.to_account_info(),
            init_amount_0,
            init_amount_1,
            0u64,  // open_time = 0 → pool is immediately tradeable
            curve_authority_seeds,
        ).map_err(|_| error!(LaunchpadError::MigrationFailed))?;

        // ── Step 4: Burn all LP tokens ──
        // Read LP balance from raw account data (SPL token layout: amount @ bytes 64..72)
        let lp_amount = {
            let data = ctx.accounts.creator_lp_token.try_borrow_data()?;
            u64::from_le_bytes(data[64..72].try_into().unwrap())
        };

        if lp_amount > 0 {
            // SPL token Burn layout: tag=8u8, amount: u64 LE (9 bytes total)
            // Accounts: [source(writable), mint(writable), authority(signer)]
            let mut burn_data = vec![8u8];
            burn_data.extend_from_slice(&lp_amount.to_le_bytes());
            let burn_ix = Instruction {
                program_id: *ctx.accounts.token_program.key,
                accounts: vec![
                    AccountMeta::new(*ctx.accounts.creator_lp_token.key, false),
                    AccountMeta::new(*ctx.accounts.lp_mint.key, false),
                    AccountMeta::new_readonly(*ctx.accounts.curve_authority.key, true),
                ],
                data: burn_data,
            };
            invoke_signed(
                &burn_ix,
                &[
                    ctx.accounts.creator_lp_token.to_account_info(),
                    ctx.accounts.lp_mint.to_account_info(),
                    ctx.accounts.curve_authority.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                ],
                &[curve_authority_seeds],
            )?;
        }

        // Raydium has paid pool creation rent/fees. Return the remainder of
        // the temporary curve-funded budget to the curve treasury.
        let unused_funding = ctx.accounts.curve_authority.lamports();
        if unused_funding > 0 {
            transfer_from_curve_authority(
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.curve_authority.to_account_info(),
                ctx.accounts.curve_treasury.to_account_info(),
                mint_key,
                auth_bump,
                unused_funding,
            )?;
        }

        // ── Step 5: Finalise ──
        let curve = &mut ctx.accounts.curve;
        curve.migrated = true;
        emit!(CurveMigrated { mint: mint_key, real_sol_reserves: sol_reserves });
        Ok(())
    }
}

/// Transfers SOL from the System-owned curve treasury using its PDA signer.
/// Kept outside `mark_migrated` so the Raydium CPI handler remains below the
/// Solana BPF stack-frame limit.
fn transfer_from_curve_treasury<'info>(
    system_program: AccountInfo<'info>,
    treasury: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    mint: Pubkey,
    treasury_bump: u8,
    amount: u64,
) -> Result<()> {
    let treasury_seeds: &[&[u8]] = &[b"treasury", mint.as_ref(), &[treasury_bump]];
    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            system_program,
            anchor_lang::system_program::Transfer {
                from: treasury,
                to: destination,
            },
            &[treasury_seeds],
        ),
        amount,
    )
}

/// Returns unused temporary Raydium funding from curve_authority.
#[inline(never)]
fn transfer_from_curve_authority<'info>(
    system_program: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    mint: Pubkey,
    authority_bump: u8,
    amount: u64,
) -> Result<()> {
    let authority_seeds: &[&[u8]] = &[
        b"curve_authority",
        mint.as_ref(),
        &[authority_bump],
    ];
    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            system_program,
            anchor_lang::system_program::Transfer {
                from: authority,
                to: destination,
            },
            &[authority_seeds],
        ),
        amount,
    )
}

// ---- State ----

#[account]
pub struct Curve {
    pub mint: Pubkey,
    pub creator: Pubkey,
    /// Legacy launch-authority field retained to preserve the live account layout.
    /// Migration is permissionless.
    pub authority: Pubkey,
    pub virtual_sol_reserves: u64,
    pub virtual_token_reserves: u64,
    pub real_sol_reserves: u64,
    pub real_token_reserves: u64, // tokens still available to sell on the curve
    pub airdrop_bps: u16,
    pub migrated: bool,
    pub ready_to_migrate: bool,
    pub bump: u8,
    pub curve_authority_bump: u8,
}

/// Human-readable launch information.  This is deliberately a separate PDA
/// instead of extending `Curve`, whose serialized layout is already live.
#[account]
pub struct LaunchMetadata {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub bump: u8,
}

impl LaunchMetadata {
    pub const LEN: usize = 8 + 32 + 32 + (4 + 32) + (4 + 10) + (4 + 200) + 1;
}

impl Curve {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 2 + 1 + 1 + 1 + 1; // +32 for authority
}

// ---- Accounts ----

#[derive(Accounts)]
#[instruction(name: String, symbol: String, uri: String, airdrop_bps: u16)]
pub struct CreateLaunch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(init, payer = creator, mint::decimals = 6, mint::authority = curve_authority)]
    pub mint: Account<'info, Mint>,

    #[account(init, payer = creator, space = Curve::LEN, seeds = [b"curve", mint.key().as_ref()], bump)]
    pub curve: Account<'info, Curve>,

    /// Display data is separate from Curve so old Curve accounts stay valid.
    #[account(init, payer = creator, space = LaunchMetadata::LEN, seeds = [b"metadata", mint.key().as_ref()], bump)]
    pub metadata: Account<'info, LaunchMetadata>,

    /// PDA that holds mint authority for this launch
    #[account(seeds = [b"curve_authority", mint.key().as_ref()], bump)]
    pub curve_authority: SystemAccount<'info>,

    /// PDA that exclusively controls the holder-airdrop reserve.
    #[account(seeds = [b"airdrop_authority", mint.key().as_ref()], bump)]
    pub airdrop_authority: SystemAccount<'info>,

    /// CHECK: initialized at this exact PDA, with zero data and System Program
    /// ownership; the Trade context subsequently enforces SystemAccount.
    /// Initializing it prevents a first small buy leaving it below rent-exempt.
    #[account(init, payer = creator, space = 0, seeds = [b"treasury", mint.key().as_ref()], bump, owner = system_program::ID)]
    pub curve_treasury: UncheckedAccount<'info>,

    #[account(init, payer = creator, associated_token::mint = mint, associated_token::authority = curve_authority)]
    pub curve_token_vault: Account<'info, TokenAccount>,

    /// Dedicated holder-airdrop reserve. Its distinct PDA owner prevents an
    /// ATA collision with `curve_token_vault` and prevents creator withdrawal.
    #[account(init, payer = creator, associated_token::mint = mint, associated_token::authority = airdrop_authority)]
    pub airdrop_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitializeCurveTreasury<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [b"curve", curve.mint.as_ref()], bump = curve.bump)]
    pub curve: Account<'info, Curve>,

    /// CHECK: initialized at this exact PDA, with zero data and System Program
    /// ownership; it is validated as a SystemAccount when used for trading.
    #[account(init, payer = payer, space = 0, seeds = [b"treasury", curve.mint.as_ref()], bump, owner = system_program::ID)]
    pub curve_treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetLaunchMetadata<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(has_one = creator)]
    pub curve: Account<'info, Curve>,

    #[account(
        init_if_needed,
        payer = creator,
        space = LaunchMetadata::LEN,
        seeds = [b"metadata", curve.mint.as_ref()],
        bump
    )]
    pub metadata: Account<'info, LaunchMetadata>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundDistributor<'info> {
    #[account(mut, address = curve.creator @ LaunchpadError::Unauthorized)]
    pub creator: Signer<'info>,

    #[account(seeds = [b"curve", curve.mint.as_ref()], bump = curve.bump)]
    pub curve: Account<'info, Curve>,

    #[account(seeds = [b"airdrop_authority", curve.mint.as_ref()], bump)]
    pub airdrop_authority: SystemAccount<'info>,

    #[account(
        mut,
        associated_token::mint = curve.mint,
        associated_token::authority = airdrop_authority,
    )]
    pub airdrop_vault: Account<'info, TokenAccount>,

    #[account(owner = merkle_distributor::ID)]
    pub distributor: Account<'info, Distributor>,

    #[account(
        mut,
        associated_token::mint = curve.mint,
        associated_token::authority = distributor,
    )]
    pub epoch_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut, seeds = [b"curve", curve.mint.as_ref()], bump = curve.bump)]
    pub curve: Account<'info, Curve>,

    #[account(seeds = [b"curve_authority", curve.mint.as_ref()], bump = curve.curve_authority_bump)]
    pub curve_authority: SystemAccount<'info>,

    /// PDA system account that holds the curve's SOL treasury; owned by this program
    #[account(mut, seeds = [b"treasury", curve.mint.as_ref()], bump)]
    pub curve_treasury: SystemAccount<'info>,

    #[account(mut)]
    pub curve_token_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub buyer_token_account: Account<'info, TokenAccount>,

    /// CHECK: validated by reward_vault program via CPI
    #[account(mut)]
    pub reward_vault_pool: UncheckedAccount<'info>,
    #[account(mut)]
    pub reward_vault_sol: SystemAccount<'info>,
    pub reward_vault_program: Program<'info, RewardVaultProgram>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Migrate<'info> {
    #[account(
        mut,
        seeds = [b"curve", curve.mint.as_ref()],
        bump = curve.bump,
    )]
    pub curve: Account<'info, Curve>,

    /// Any wallet may trigger a ready migration. It only pays the transaction
    /// fee and, if absent, the curve-authority WSOL ATA rent; pool setup itself
    /// is funded by the curve treasury.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// PDA that is the "creator" from Raydium's perspective — signs the CPI
    #[account(mut, seeds = [b"curve_authority", curve.mint.as_ref()], bump = curve.curve_authority_bump)]
    pub curve_authority: SystemAccount<'info>,

    /// Holds the curve's accumulated SOL treasury (will be drained to WSOL)
    #[account(mut, seeds = [b"treasury", curve.mint.as_ref()], bump)]
    pub curve_treasury: SystemAccount<'info>,

    /// curve_authority's ATA for the memecoin — source of token liquidity
    #[account(mut)]
    pub curve_token_vault: Account<'info, TokenAccount>,

    /// The memecoin mint
    pub memecoin_mint: Account<'info, Mint>,

    /// WSOL mint (always So11111111111111111111111111111111111111112)
    #[account(address = native_mint::ID)]
    pub wsol_mint: Account<'info, Mint>,

    /// curve_authority's WSOL ATA — created here if needed; receives wrapped SOL
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = wsol_mint,
        associated_token::authority = curve_authority,
    )]
    pub curve_authority_wsol: Account<'info, TokenAccount>,

    /// CHECK: pre-deployed Raydium AMM config account (caller supplies correct address per cluster)
    pub amm_config: UncheckedAccount<'info>,

    /// CHECK: Raydium vault-authority PDA (seeds: AUTH_SEED on Raydium's program)
    #[account(mut)]
    pub raydium_authority: UncheckedAccount<'info>,

    /// CHECK: new pool state account — allocated and initialized by Raydium during the CPI
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,

    /// CHECK: LP mint — created by Raydium during the CPI
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,

    /// CHECK: LP token ATA for curve_authority — filled by Raydium, then we burn it
    #[account(mut)]
    pub creator_lp_token: UncheckedAccount<'info>,

    /// CHECK: Raydium token-0 vault — initialized by Raydium during the CPI
    #[account(mut)]
    pub token_0_vault: UncheckedAccount<'info>,

    /// CHECK: Raydium token-1 vault — initialized by Raydium during the CPI
    #[account(mut)]
    pub token_1_vault: UncheckedAccount<'info>,

    /// CHECK: Raydium create-pool fee receiver (cluster-specific address from Raydium docs)
    #[account(mut)]
    pub create_pool_fee: UncheckedAccount<'info>,

    /// CHECK: observation state account — allocated by Raydium during the CPI
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    /// CHECK: Raydium CPMM program — validated in instruction body against known IDs
    pub raydium_cpmm_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// ---- Events ----

#[event]
pub struct LaunchCreated {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub airdrop_bps: u16,
    pub airdrop_amount: u64,
    pub sellable_amount: u64,
}

#[event]
pub struct TradeExecuted {
    pub mint: Pubkey,
    pub buyer: Pubkey,
    pub is_buy: bool,
    pub sol_amount: u64,
    pub token_amount: u64,
    pub fee: u64,
}

#[event]
pub struct CurveMigrated {
    pub mint: Pubkey,
    pub real_sol_reserves: u64,
}

// ---- Errors ----

#[error_code]
pub enum LaunchpadError {
    #[msg("airdrop_bps must be between 100 (1%) and 500 (5%)")]
    InvalidAirdropBps,
    #[msg("name/symbol/uri exceeds max length")]
    MetadataTooLong,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("not enough liquidity on the curve")]
    InsufficientLiquidity,
    #[msg("curve has already migrated to an external AMM")]
    AlreadyMigrated,
    #[msg("curve has not reached the migration threshold yet")]
    NotReadyToMigrate,
    #[msg("signer is not the curve authority")]
    Unauthorized,
    #[msg("raydium CPMM pool creation CPI failed")]
    MigrationFailed,
    #[msg("invalid Raydium CPMM program ID")]
    InvalidRaydiumProgram,
    #[msg("distributor does not belong to this launch")]
    InvalidDistributor,
    #[msg("funding would exceed the distributor epoch allocation")]
    DistributorOverfunded,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("curve treasury fee surplus cannot cover Raydium pool setup")]
    InsufficientMigrationFunding,
}
