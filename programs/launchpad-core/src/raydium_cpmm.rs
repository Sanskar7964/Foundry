use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

// ---- Program IDs ----

pub const CPMM_ID_MAINNET: &str = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
pub const CPMM_ID_DEVNET: &str = "CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW";

/// Returns true if `key` matches either the mainnet or devnet Raydium CPMM program.
pub fn is_valid_cpmm_program(key: &Pubkey) -> bool {
    let mainnet: Pubkey = CPMM_ID_MAINNET.parse().unwrap();
    let devnet: Pubkey = CPMM_ID_DEVNET.parse().unwrap();
    key == &mainnet || key == &devnet
}

// ---- Seeds (mirrors raydium-cp-swap source) ----

pub const AUTH_SEED: &[u8] = b"vault_and_lp_mint_auth_seed";
pub const POOL_SEED: &[u8] = b"pool";
pub const LP_MINT_SEED: &[u8] = b"pool_lp_mint";
pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";
pub const OBSERVATION_SEED: &[u8] = b"observation";

// ---- Instruction discriminator ----
// sha256("global:initialize")[0..8]
pub const INITIALIZE_IX_DISC: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];

// ---- CPI helper ----

/// Calls Raydium CPMM `initialize` via raw `invoke_signed`.
///
/// The `curve_authority` PDA is the "creator" from Raydium's perspective — it
/// signs using `curve_authority_seeds`.
///
/// # Arguments
/// * `init_amount_0` – token-0 amount to deposit (sorted order)
/// * `init_amount_1` – token-1 amount to deposit (sorted order)
/// * `open_time`     – Unix timestamp after which the pool accepts swaps (0 = immediate)
#[allow(clippy::too_many_arguments)]
#[inline(never)]
pub fn cpi_initialize<'info>(
    cpmm_program: &AccountInfo<'info>,
    // Raydium-specific accounts (must appear in exactly this order per IDL)
    creator: &AccountInfo<'info>,           // curve_authority PDA
    amm_config: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,         // Raydium vault-authority PDA
    pool_state: &AccountInfo<'info>,
    token_0_mint: &AccountInfo<'info>,
    token_1_mint: &AccountInfo<'info>,
    lp_mint: &AccountInfo<'info>,
    creator_token_0: &AccountInfo<'info>,   // curve token-0 vault (source)
    creator_token_1: &AccountInfo<'info>,   // curve token-1 vault (source)
    creator_lp_token: &AccountInfo<'info>,  // LP destination ATA
    token_0_vault: &AccountInfo<'info>,
    token_1_vault: &AccountInfo<'info>,
    create_pool_fee: &AccountInfo<'info>,
    observation_state: &AccountInfo<'info>,
    // Programs / sysvars
    token_program: &AccountInfo<'info>,
    token_0_program: &AccountInfo<'info>,
    token_1_program: &AccountInfo<'info>,
    associated_token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    rent: &AccountInfo<'info>,
    // Instruction data
    init_amount_0: u64,
    init_amount_1: u64,
    open_time: u64,
    // Signer seeds for `creator` (curve_authority PDA)
    curve_authority_seeds: &[&[u8]],
) -> Result<()> {
    // Build instruction data: discriminator (8) + u64 + u64 + u64 (24) = 32 bytes
    let mut data = Vec::with_capacity(32);
    data.extend_from_slice(&INITIALIZE_IX_DISC);
    data.extend_from_slice(&init_amount_0.to_le_bytes());
    data.extend_from_slice(&init_amount_1.to_le_bytes());
    data.extend_from_slice(&open_time.to_le_bytes());

    // Account metas — order matches the Raydium CPMM `Initialize` IDL exactly
    let accounts = vec![
        AccountMeta::new(*creator.key, true),                       // creator (signer, writable)
        AccountMeta::new_readonly(*amm_config.key, false),          // amm_config
        AccountMeta::new_readonly(*authority.key, false),           // authority (Raydium PDA)
        AccountMeta::new(*pool_state.key, false),                   // pool_state (writable, init'd by Raydium)
        AccountMeta::new_readonly(*token_0_mint.key, false),        // token_0_mint
        AccountMeta::new_readonly(*token_1_mint.key, false),        // token_1_mint
        AccountMeta::new(*lp_mint.key, false),                      // lp_mint (writable)
        AccountMeta::new(*creator_token_0.key, false),              // creator_token_0 (writable, source)
        AccountMeta::new(*creator_token_1.key, false),              // creator_token_1 (writable, source)
        AccountMeta::new(*creator_lp_token.key, false),             // creator_lp_token (writable, dest)
        AccountMeta::new(*token_0_vault.key, false),                // token_0_vault (writable)
        AccountMeta::new(*token_1_vault.key, false),                // token_1_vault (writable)
        AccountMeta::new(*create_pool_fee.key, false),              // create_pool_fee (writable)
        AccountMeta::new(*observation_state.key, false),            // observation_state (writable)
        AccountMeta::new_readonly(*token_program.key, false),       // token_program
        AccountMeta::new_readonly(*token_0_program.key, false),     // token_0_program
        AccountMeta::new_readonly(*token_1_program.key, false),     // token_1_program
        AccountMeta::new_readonly(*associated_token_program.key, false), // associated_token_program
        AccountMeta::new_readonly(*system_program.key, false),      // system_program
        AccountMeta::new_readonly(*rent.key, false),                // rent
    ];

    let ix = Instruction {
        program_id: *cpmm_program.key,
        accounts,
        data,
    };

    let account_infos = [
        creator.clone(),
        amm_config.clone(),
        authority.clone(),
        pool_state.clone(),
        token_0_mint.clone(),
        token_1_mint.clone(),
        lp_mint.clone(),
        creator_token_0.clone(),
        creator_token_1.clone(),
        creator_lp_token.clone(),
        token_0_vault.clone(),
        token_1_vault.clone(),
        create_pool_fee.clone(),
        observation_state.clone(),
        token_program.clone(),
        token_0_program.clone(),
        token_1_program.clone(),
        associated_token_program.clone(),
        system_program.clone(),
        rent.clone(),
        cpmm_program.clone(),
    ];

    invoke_signed(&ix, &account_infos, &[curve_authority_seeds])?;
    Ok(())
}

