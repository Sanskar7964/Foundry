# Airdrop claim manifest

After creating and funding a Merkle distributor epoch, publish a JSON document
at `frontend/public/airdrop-claims.json`. The claim page filters it by the
connected wallet and verifies that each epoch PDA exists. Set
`NEXT_PUBLIC_AIRDROP_CLAIMS_URL` only when hosting the manifest elsewhere.

```json
{
  "claims": [
    {
      "claimant": "holder-wallet-public-key",
      "mint": "coin-mint-public-key",
      "epoch": 1,
      "amount": "2500000",
      "proof": ["32-byte-hex-proof-node"],
      "name": "Example Coin",
      "symbol": "EXAMPLE"
    }
  ]
}
```

`amount` is an unsigned integer string in the mint's raw units. `proof` is the
sorted-pair Keccak Merkle proof emitted by `app/build-merkle-tree.ts`; use an
empty array for a valid single-leaf epoch. The manifest may also be a JSON
array of claim entries directly.
