/* ==========================================================================
   pumpbubble.fun — casino hot wallets

   Stake, Roobet, Rainbet, Shuffle, BC.Game and the rest are off-chain
   companies that publish nothing about their size. What they cannot hide is
   their hot wallets: every deposit and every withdrawal is a transaction on a
   public chain, and the casino's side of it is a public address.

   **Every address here was read from the chain, not from a label.** The seeds
   are transaction hashes that public trackers attribute to a casino; for each
   one the transaction itself is fetched and the casino's side taken — the
   recipient of a deposit, the sender of a withdrawal. `src` is that hash, so
   any row can be re-derived by anyone with an RPC. `seen` is how many seed
   transactions landed on the address, which is a confidence measure: Stake's
   Tron wallet was the counterparty in 93 of 175 Stake transactions sampled.

   **Verified before it was written**, twice. First, an address that has code
   is a contract, never a wallet — the USDC token contract arrived here once
   through a malformed transaction and was rejected on that check. Second, the
   summed balances per casino were compared to what circus.fyi publishes for
   its own (larger) wallet sets: Stake 76%, Duel 75%, Roobet 72%, Rainbet 52%,
   everything under and nothing over. A mislabelled wallet would have blown
   past. The gap is coverage — wallets and chains we have not seen a hash for
   yet — not error.

   Regenerate or extend with `node scripts/casino-wallets.mjs`. More seed
   hashes mean more wallets; the tracker endpoints refresh daily.

   Nothing here is fetched at runtime from any tracker. The map reads balances
   from public RPCs, prices them with the feed it already has, and shows the
   sum under the label it deserves: hot wallets we can see, not treasury.
   ========================================================================== */

export const WALLETS = [
  { casino: "1win", chain: "tron", addr: "TRKZWuxZ5pPBoK3ei1nQDnjAo4YyUFUMKB", seen: 5, src: "4ede1aa1f244c23d0bc8ccf64682b5f0c100cdda9a7c31c489b2703aaf2c5b9c" },
  { casino: "BC.Game", chain: "solana", addr: "JEBRptmAAjqtxg6c4WLQDaZPeEA8RXnW4dVyhvsvZnxQ", seen: 6, src: "389F7BfVK2uQJ6S3XFC1mr6UP1cDyoFbNDwwjoDhfbtR1he9ZN3uCP5CD8X5h4Eiayt3QNHQqZYkTWDrjodugZ1p" },
  { casino: "CasinoBet", chain: "tron", addr: "TAwRECE1AJgawySxGB8FmqhL8URs1hj1J2", seen: 2, src: "414ba5888806115ed41d56fb898fac089de6f7067262408a441f17f3508e2855" },
  { casino: "CasinoBet", chain: "ethereum", addr: "0x22fff189c37302c02635322911c3b64f80ce7203", seen: 1, src: "0xff86dc21c6bc5dcb7c7f20b2f3cb1ecb573015ba7be6224b3de52670114fffff" },
  { casino: "Duel", chain: "ethereum", addr: "0x7b09fc3bdd9a1eb0059f0c9d391f5d684e0f9918", seen: 9, src: "0xddb3478c4a2be5cf6f602d0db9fefd3020f834ea6514968b3eee534a0b174bbc" },
  { casino: "Duel", chain: "solana", addr: "HjuvLWkeoRVuiDCVjZeWrj3cYzG2KV9CExqEJqJQJqJA", seen: 5, src: "4dPMaX2T4sKvYXPrFnHbajZ1v9UtbVG4twkdai3UAzedcsZQs75C5Zvs5Q1udgeEdJ3GSRUaVZEt9S6w3AdCat6b" },
  { casino: "Duel", chain: "tron", addr: "TDWxBugxYrTWDUnrKEyNNQ1FNxXraN4SFk", seen: 4, src: "8442388e5188507ba31e4e06ad89d011e3d378ccc6d9e320f19c111eeaa17e8c" },
  { casino: "Gamdom", chain: "solana", addr: "8LJat1KRjxoDWHLH44ptao16jBGaJWLagfEuiJXnpxs3", seen: 4, src: "J2tYNMpFCV93oDfQhwMjCTousTrDtX7j4wYSKRrbfDfNaP5tCJVzPG8FWTLkREPMDMHFXrUegX6Gy8pEvJBjJET" },
  { casino: "Gamdom", chain: "tron", addr: "TKDYroWqvxbEfJBmVa81rKCSoHn7sDCLQE", seen: 1, src: "1d92014b6753c391d14e1924a9b53cdd3306d13b3cc69ee3a378abe8985aa6cb" },
  { casino: "LuckyFun", chain: "ethereum", addr: "0xe4f9b0a83eb4552508ad9bf8c83662d1c7004a03", seen: 1, src: "0xdf0a1845d29f76d3ecbae48d6b0b90528f4b7a0393fa463bd7180fb42ab23665" },
  { casino: "Packdraw", chain: "solana", addr: "747fiZw2D5j7PJgVMpMJWY4s9AnoVpQz6F1QcwuBMmwx", seen: 1, src: "2MsXwP17nZPNX9WHDHCaYFSjGHGXGywSD4bsN26wZHJ89VxqVQ6mJoj4FxLrm3dAEFc7sdzeFU5AeLVZY3PE5Vkg" },
  { casino: "Rainbet", chain: "ethereum", addr: "0x307576dd4f73f91bb8c4a2edb762938e8e067d31", seen: 6, src: "0x9be2a462612e400eead7faacdb5cd9a1959d90d0e637d71ab6a7c466771e0b89" },
  { casino: "Rainbet", chain: "tron", addr: "TKBuRdEFxHGb9RWoUtZXYS7dGJC7sqGd6T", seen: 2, src: "27cb2be8e6da608dff0809dfc2d4ede245c5d34bae21885af19e3767d6c3698b" },
  { casino: "Rainbet", chain: "solana", addr: "5HQZd9ovzAF1TLnHRAq1zcSnXC9HAp3EwhoxMHvo8rxB", seen: 1, src: "4xV3HCLp3RM2nEzvTsqVrYBvUNsNar8hHHkFifsbWrKyWvmDCHppjTpqYo7ima2nya4MikgMxU89CMd62Dnx7Xu9" },
  { casino: "Rollbit", chain: "tron", addr: "TYsQqVyppXjpB9HxFLp9PY3GwLkAHDgH7R", seen: 9, src: "29e89e907991e9f8c59587ea735550e77ab48ee38a07ed8f4d26f5df7ee5dbe3" },
  { casino: "Rollbit", chain: "solana", addr: "4nZQs4JpDpR1oDzB49bXZcgPYMv4iiyh1CjyJvadEZyr", seen: 1, src: "kshFNzsHyffouw4g3HNAAnNGMQ1dEEQzaY8Ha5jjKqDEK98vBqr3o2LNoBUfCMATdULxfmTA6Dquj33Mb6qMeTp" },
  { casino: "Roobet", chain: "tron", addr: "TMuAFEbahMYiGpVVhJY7ebU7Ad19w38BbX", seen: 21, src: "d93bd3e676fcfdd196ef605674b25cb2403bc1ceba8f2614686328a5b82c8d77" },
  { casino: "Roobet", chain: "tron", addr: "TRYtrEkTFiZbuuzt7o7ac7TVeEC5PLsnQa", seen: 10, src: "fc19c35125b07970ec8e64886705ba73f9a299ceefbd2714073b89764ab35b75" },
  { casino: "Roobet", chain: "ethereum", addr: "0xc94ebb328ac25b95db0e0aa968371885fa516215", seen: 3, src: "0x9a422983c69b5259717c57bff1acd56ec9e526c1ee0c64f994746a34cf32ae67" },
  { casino: "Roobet", chain: "ethereum", addr: "0xa26148ae51fa8e787df319c04137602cc018b521", seen: 2, src: "0x5d831087cd342d6dcdf7f7f0ffb7c8de68d18d5b6b3f5e0bdd7a6e504685b9a3" },
  { casino: "Shuffle", chain: "ethereum", addr: "0xdfaa75323fb721e5f29d43859390f62cc4b600b8", seen: 3, src: "0x87fb3091d1b5e52ceb25afc9ae1357e5da8cc08af1905c2d2e7ba02e2213902e" },
  { casino: "Shuffle", chain: "tron", addr: "TWGSJz33dNGMhQYhSRLSKKUyFNewh8JEnp", seen: 2, src: "bb68f7936db81ccf81bdd26056526e721fc38f7ecc09d25b12526dc1aedde9bd" },
  { casino: "Sportsbet.io", chain: "tron", addr: "TRShCA2zaDty28bUJRoacTN614ePmKRh7r", seen: 4, src: "0acbe75b3b822b90062c6169d4f557e2ca759469b9a8569cda7a66bd1becc339" },
  { casino: "Sportsbet.io", chain: "ethereum", addr: "0x5bcbdfb6cc624b959c39a2d16110d1f2d9204f72", seen: 2, src: "0xce46b9c0100c60293f5f6c8416520783e7ee95ba07b8aa7535f3d021cad570d0" },
  { casino: "Stake", chain: "tron", addr: "TZ8Ksz21Hk1tQuztCKCUJBRXStCav9uyjM", seen: 93, src: "ddd29b1576440531495482dc8553f06b727f935c905243e96c2d1c852d0b1849" },
  { casino: "Stake", chain: "ethereum", addr: "0x6872b6630a3afcd3117191a8403c2002e13df7de", seen: 26, src: "0xa498d90bc9132dedbccbb924214788f7178e4c0e51c08aa479ed397159b2b8d1" },
  { casino: "Stake", chain: "solana", addr: "G9X7F4JzLzbSGMCndiBdWNi5YzZZakmtkdwq7xS3Q3FE", seen: 24, src: "3b7XjnAhE1AZMVtCRosz6RKYDQBjxSXhdpa4gKEjADuH7hDk5JdB66nU3a4s3VeRoxV72SmMhYqY1UV1gtUcsbvc" },
  { casino: "Stake", chain: "ethereum", addr: "0x974caa59e49682cda0ad2bbe82983419a2ecc400", seen: 10, src: "0x0801a1f76c1538a781125764a7a93c2815a00dcafd9fb7e4baefbe609af2ccda" },
  { casino: "Stake", chain: "polygon", addr: "0x6872b6630a3afcd3117191a8403c2002e13df7de", seen: 9, src: "0x047e2e477c2f5d8cd671331921a55ad607274fb4a6fc16bd06f0c18489699b05" },
  { casino: "Winna", chain: "ethereum", addr: "0x33029cd500d4c9c3b2ac26d6e65167b24b827446", seen: 2, src: "0x7881f80bb466e50843ca7a4378c207c8e2f830fedd71b3e01a74dc96d962fae4" },
  { casino: "Yeet", chain: "ethereum", addr: "0xc55b68e4e97a945b150c0c6865a3cb4c22ccefd4", seen: 1, src: "0x7103608fcfe4734d8f07ea41d38dde9c428b8a764ccc30f9328277a37c54b41c" },
];

/* Where the casino's site is, for the card's Open button. Only the ones
   known for certain; the rest fall back to a search. */
export const SITES = {
  Stake: 'https://stake.com', Roobet: 'https://roobet.com', Rainbet: 'https://rainbet.com',
  Shuffle: 'https://shuffle.com', 'BC.Game': 'https://bc.game', Duel: 'https://duel.com',
  Gamdom: 'https://gamdom.com', Rollbit: 'https://rollbit.com', '1win': 'https://1win.com',
  'Sportsbet.io': 'https://sportsbet.io', Yeet: 'https://yeet.com', Winna: 'https://winna.com',
  Packdraw: 'https://packdraw.com',
};

/* Token contracts a hot wallet is priced on. Stablecoins are a dollar; the
   native coins are priced from the majors feed at sweep time. */
export const ERC20 = {
  ethereum: { USDT: ['0xdAC17F958D2ee523a2206206994597C13D831ec7', 6], USDC: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6] },
  polygon: { USDT: ['0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6], USDC: ['0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6], 'USDC.e': ['0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 6] },
  bsc: { USDT: ['0x55d398326f99059fF775485246999027B3197955', 18], USDC: ['0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18] },
};
export const TRC20 = { USDT: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', USDC: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8' };
export const SPL = { USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' };
export const NATIVE = { ethereum: 'ETH', polygon: 'POL', bsc: 'BNB', solana: 'SOL', tron: 'TRX' };
export const STABLE = new Set(['USDT', 'USDC', 'USDC.e']);
