use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("GtpFjU1NZM8NvE2UYfNxszmTL2SW2xU6z4318by8rYC7");

#[program]
pub mod merkle_distributor {
    use super::*;

    /// Opens a new claim epoch for a given memecoin's holder airdrop. Called
    /// by the off-chain indexer's authority key once it has snapshotted
    /// balances, computed each holder's entitlement, and built the Merkle
    /// tree. Only the 32-byte root goes on-chain — the full holder list lives
    /// off-chain (and should be published, e.g. to Arweave/IPFS, for anyone
    /// to verify against the root).
    pub fn create_distributor(
        ctx: Context<CreateDistributor>,
        epoch: u64,
        root: [u8; 32],
        total_amount: u64,
    ) -> Result<()> {
        require!(total_amount > 0, DistributorError::ZeroAmount);

        let distributor_account_info = ctx.accounts.distributor.to_account_info();
        let distributor = &mut ctx.accounts.distributor;
        distributor.mint = ctx.accounts.mint.key();
        distributor.epoch = epoch;
        distributor.root = root;
        distributor.total_amount = total_amount;
        distributor.claimed_amount = 0;
        distributor.bump = ctx.bumps.distributor;

        emit!(DistributorCreated { mint: distributor.mint, epoch, root, total_amount });
        Ok(())
    }

    /// Holder claims their entitlement for this epoch by proving membership
    /// in the Merkle tree. A ClaimReceipt PDA seeded on (distributor, claimant)
    /// makes double-claiming impossible — init will fail if it already exists.
    pub fn claim(ctx: Context<ClaimAirdrop>, epoch: u64, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        let distributor_account_info = ctx.accounts.distributor.to_account_info();
        let distributor = &mut ctx.accounts.distributor;
        require!(distributor.epoch == epoch, DistributorError::EpochMismatch);

        let leaf = keccak::hashv(&[
            &ctx.accounts.claimant.key().to_bytes(),
            &amount.to_le_bytes(),
        ]).0;

        require!(
            verify_proof(proof, distributor.root, leaf),
            DistributorError::InvalidProof
        );

        let mint_key = distributor.mint;
        let epoch_bytes = distributor.epoch.to_le_bytes();
        let seeds = &[b"distributor", mint_key.as_ref(), epoch_bytes.as_ref(), &[distributor.bump]];
        let signer = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.epoch_vault.to_account_info(),
                    to: ctx.accounts.claimant_token_account.to_account_info(),
                    authority: distributor_account_info,
                },
                signer,
            ),
            amount,
        )?;

        distributor.claimed_amount = distributor.claimed_amount.checked_add(amount).unwrap();
        ctx.accounts.receipt.claimed = true;
        ctx.accounts.receipt.amount = amount;

        emit!(AirdropClaimed { mint: mint_key, epoch, claimant: ctx.accounts.claimant.key(), amount });
        Ok(())
    }

    /// One-time setup: registers the keeper address allowed to post Merkle
    /// roots via create_distributor. Call immediately after deployment.
    /// Pass your Squads multisig address as `keeper` for production.
    pub fn initialize_keeper(ctx: Context<InitializeKeeper>, keeper: Pubkey) -> Result<()> {
        ctx.accounts.config.authority = keeper;
        ctx.accounts.config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Rotates the keeper to a new address. Must be signed by the current keeper.
    pub fn update_keeper(ctx: Context<UpdateKeeper>, new_keeper: Pubkey) -> Result<()> {
        ctx.accounts.config.authority = new_keeper;
        Ok(())
    }
}

fn verify_proof(proof: Vec<[u8; 32]>, root: [u8; 32], leaf: [u8; 32]) -> bool {
    let mut computed = leaf;
    for node in proof.into_iter() {
        computed = if computed <= node {
            keccak::hashv(&[&computed, &node]).0
        } else {
            keccak::hashv(&[&node, &computed]).0
        };
    }
    computed == root
}

#[account]
pub struct Distributor {
    pub mint: Pubkey,
    pub epoch: u64,
    pub root: [u8; 32],
    pub total_amount: u64,
    pub claimed_amount: u64,
    pub bump: u8,
}
impl Distributor {
    pub const LEN: usize = 8 + 32 + 8 + 32 + 8 + 8 + 1;
}

#[account]
pub struct ClaimReceipt {
    pub claimed: bool,
    pub amount: u64,
}
impl ClaimReceipt {
    pub const LEN: usize = 8 + 1 + 8;
}

#[account]
pub struct KeeperConfig {
    pub authority: Pubkey, // the only address allowed to call create_distributor
    pub bump: u8,
}
impl KeeperConfig {
    pub const LEN: usize = 8 + 32 + 1;
}

#[derive(Accounts)]
#[instruction(epoch: u64, root: [u8; 32], total_amount: u64)]
pub struct CreateDistributor<'info> {
    #[account(mut)]
    pub authority: Signer<'info>, // must be the registered keeper
    /// Enforces authority == keeper_config.authority; rejects any other signer
    #[account(
        seeds = [b"keeper_config"],
        bump = keeper_config.bump,
        has_one = authority @ DistributorError::KeeperUnauthorized,
    )]
    pub keeper_config: Account<'info, KeeperConfig>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = authority, space = Distributor::LEN, seeds = [b"distributor", mint.key().as_ref(), epoch.to_le_bytes().as_ref()], bump)]
    pub distributor: Account<'info, Distributor>,
    #[account(init, payer = authority, associated_token::mint = mint, associated_token::authority = distributor)]
    pub epoch_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitializeKeeper<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = KeeperConfig::LEN, seeds = [b"keeper_config"], bump)]
    pub config: Account<'info, KeeperConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateKeeper<'info> {
    #[account(
        mut,
        seeds = [b"keeper_config"],
        bump = config.bump,
        has_one = authority @ DistributorError::KeeperUnauthorized,
    )]
    pub config: Account<'info, KeeperConfig>,
    pub authority: Signer<'info>, // current keeper must sign the rotation
}


#[derive(Accounts)]
#[instruction(epoch: u64, amount: u64)]
pub struct ClaimAirdrop<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,
    #[account(mut, seeds = [b"distributor", distributor.mint.as_ref(), epoch.to_le_bytes().as_ref()], bump = distributor.bump)]
    pub distributor: Account<'info, Distributor>,
    #[account(mut)]
    pub epoch_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub claimant_token_account: Account<'info, TokenAccount>,
    #[account(init, payer = claimant, space = ClaimReceipt::LEN, seeds = [b"receipt", distributor.key().as_ref(), claimant.key().as_ref()], bump)]
    pub receipt: Account<'info, ClaimReceipt>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct DistributorCreated {
    pub mint: Pubkey,
    pub epoch: u64,
    pub root: [u8; 32],
    pub total_amount: u64,
}

#[event]
pub struct AirdropClaimed {
    pub mint: Pubkey,
    pub epoch: u64,
    pub claimant: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum DistributorError {
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("epoch does not match distributor")]
    EpochMismatch,
    #[msg("invalid merkle proof")]
    InvalidProof,
    #[msg("signer is not the registered keeper")]
    KeeperUnauthorized,
}
