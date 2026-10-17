import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowanceFor,
  breakEven1e8,
  encodeBuy,
  encodeCalculate,
  encodePayOff,
  payout6,
  pickDays,
  units,
  unitsToUsd6,
  usd6,
  usd8,
  usdToUnits,
  words,
  int256,
} from "../src/core.ts";

test("pickDays keeps lengths the market sells and explains changes", () => {
  assert.deepEqual(pickDays("BTC"), { days: 7 });
  assert.deepEqual(pickDays("BTC", 10), { days: 10 });
  assert.equal(pickDays("BTC", 30).days, 14);
  assert.match(pickDays("BTC", 30).note!, /7 to 14 days/);
  assert.equal(pickDays("ETH", 14).days, 60);
  assert.equal(pickDays("ETH", 120).days, 90);
});

test("usdToUnits round-trips: $96.80 of ETH at $2,419.89 is worth $96.80 again", () => {
  const price = 241988875863n; // Chainlink, 8 decimals
  const u = usdToUnits(96.8, price, 18);
  assert.equal(units(u, 18), "0.040001"); // 96.80 / 2,419.89
  const back = unitsToUsd6(u, price, 18);
  assert.ok(back <= 96800000n && 96800000n - back <= 1n, `got ${back}`);
});

test("usdToUnits for BTC uses 8 decimals", () => {
  const price = 8137919500000n; // $81,379.195
  assert.equal(usdToUnits(81.38, price, 8), 100000n);
});

test("payout matches the fork run: frozen 2,418.67, price 2,900, 0.04 ETH pays 19.25 USDC", () => {
  const strike = 241867278307n;
  const price = 290000000000n;
  const p = payout6(price, strike, 40000000000000000n, 18);
  assert.equal(p, 19253088n); // the exact amount the fork paid
  assert.equal(payout6(strike - 1n, strike, 40000000000000000n, 18), 0n);
});

test("break-even is strike plus fee per coin", () => {
  // fee 8.088533 on 0.04 ETH = 202.21 per ETH above 2,418.67
  const be = breakEven1e8(241867278307n, 8088533n, 40000000000000000n, 18);
  assert.equal(usd8(be), "$2,620.89");
});

test("allowance adds 5% and rounds up", () => {
  assert.equal(allowanceFor(8088533n), 8492960n);
  assert.equal(allowanceFor(1n), 5_000_000n);
  assert.equal(allowanceFor(397_627n), 5_000_000n);
});

test("money and amount formatting", () => {
  assert.equal(usd6(1620127n), "$1.62");
  assert.equal(usd6(10501017n), "$10.50");
  assert.equal(usd8(8137919500000n), "$81,379.20");
  assert.equal(units(40000000000000000n, 18), "0.04");
  assert.equal(units(100000n, 8, 8), "0.001");
  assert.equal(unitsToUsd6(40000000000000000n, 241988875863n, 18), 96795550n);
});

test("calldata matches cast's encoding", () => {
  assert.equal(
    encodeCalculate(40000000000000000n, 5184000n),
    "0xd666b433000000000000000000000000000000000000000000000000008e1bc9bf04000000000000000000000000000000000000000000000000000000000000004f1a0000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000",
  );
  assert.equal(
    encodeBuy(
      "0x2727B807D22fCAeB7F900F49894054Ed92b9125B",
      "0x1111111111111111111111111111111111111111",
      40000000000000000n,
      5184000n,
    ),
    "0x0e5024d70000000000000000000000002727b807d22fcaeb7f900f49894054ed92b9125b0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000008e1bc9bf04000000000000000000000000000000000000000000000000000000000000004f1a0000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000",
  );
  assert.match(encodePayOff(16685n, "0x1111111111111111111111111111111111111111"), /^0x914fb518/);
  assert.throws(() => encodeBuy("0x12", "0x1111111111111111111111111111111111111111", 1n, 1n));
});

test("words and int256 decode call results", () => {
  const hex = "0x" + "0".repeat(63) + "1" + "f".repeat(64);
  const [a, b] = words(hex);
  assert.equal(a, 1n);
  assert.equal(int256(b), -1n);
  assert.throws(() => words("0x123"));
});
