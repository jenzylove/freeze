import { test } from "node:test";
import assert from "node:assert/strict";
import { b58decode, buildSolanaTx } from "../src/relay.ts";

test("base58 decodes known Solana addresses to 32 bytes", () => {
  assert.equal(b58decode("11111111111111111111111111111111").length, 32);
  assert.deepEqual([...b58decode("11111111111111111111111111111111")], new Array(32).fill(0));
  assert.equal(b58decode("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").length, 32);
  assert.throws(() => b58decode("0OIl"));
});

test("unsigned legacy transaction: one signer who pays fees, zero blockhash, keys merged", () => {
  const payer = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const tx = Buffer.from(
    buildSolanaTx(payer, [
      {
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        data: "0x0102",
        keys: [
          { pubkey: payer, isSigner: true, isWritable: true },
          { pubkey: payer, isSigner: false, isWritable: false },
          { pubkey: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", isSigner: false, isWritable: true },
        ],
      },
    ]),
    "base64",
  );
  assert.equal(tx[0], 1); // one signature slot
  assert.ok(tx.subarray(1, 65).every((b) => b === 0)); // empty signature
  const m = tx.subarray(65);
  assert.deepEqual([m[0], m[1], m[2]], [1, 0, 1]); // 1 signer, 0 readonly signed, 1 readonly unsigned (program)
  assert.equal(m[3], 3); // payer, mint, program
  assert.deepEqual([...m.subarray(4, 36)], [...b58decode(payer)]); // fee payer first
  assert.ok(m.subarray(4 + 96, 4 + 128).every((b) => b === 0)); // blockhash placeholder
});

test("a second signer is refused", () => {
  assert.throws(() =>
    buildSolanaTx("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", [
      { programId: "11111111111111111111111111111111", data: "0x", keys: [{ pubkey: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", isSigner: true, isWritable: true }] },
    ]),
  );
});
