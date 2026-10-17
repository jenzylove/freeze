import { ASSETS, HEGIC, SEL, batch, word, words, priceCall, parsePrice, unitsToUsd6, breakEven1e8, payout6, usd6, usd8, units, shortAddr, arbiscan, clock, freezeText } from "./chain.js";

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const raw = params.get("id");
const STATES = ["#state-empty", "#state-loading", "#state-error", "#state-notfound", "#state-notfreeze", "#state-card"];

function show(id) { for (const s of STATES) $(s).hidden = s !== id; }

function fmtDuration(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d >= 1) return d + (d === 1 ? " day" : " days") + (h ? ", " + h + "h" : "");
  if (h >= 1) return h + "h " + m + "m";
  return Math.max(1, m) + " min";
}
const dropCents = (s) => s.replace(/\.\d\d$/, "");

async function load() {
  if (!raw) { show("#state-empty"); return; }
  if (!/^\d{1,9}$/.test(raw)) { show("#state-notfound"); return; }
  const id = BigInt(raw);
  show("#state-loading");
  try {
    const [ll, own, pb, pe] = await batch([
      { to: HEGIC.treasury, data: SEL.lockedLiquidity + word(id) },
      { to: HEGIC.cards, data: SEL.ownerOf + word(id) },
      priceCall("BTC"), priceCall("ETH"),
    ]);
    if (!ll.ok) throw new Error("Could not read the card from Arbitrum.");
    const lw = words(ll.result);
    const strategy = "0x" + lw[1].toString(16).padStart(40, "0");
    if (lw[1] === 0n || !own.ok) { show("#state-notfound"); return; }
    let asset = null;
    for (const a of ["BTC", "ETH"]) if (ASSETS[a].strategy.toLowerCase() === strategy) asset = a;
    if (!asset) { show("#state-notfreeze"); return; }
    const now = parsePrice(asset === "BTC" ? pb : pe);
    const [sd, po] = await batch([
      { to: strategy, data: SEL.strategyData + word(id) },
      { to: strategy, data: SEL.payOffAmount + word(id) },
    ]);
    if (!sd.ok) throw new Error("Could not read the frozen price from Arbitrum.");
    const [amount, strike] = words(sd.result);
    const fee6 = lw[3];
    const expiry = Number(lw[4]);
    const owner = "0x" + words(own.result)[0].toString(16).padStart(40, "0");
    const dec = ASSETS[asset].decimals;
    // Prefer the contract's own number; fall back to the same math if the call reverts.
    const worth6 = po.ok ? words(po.result)[0] : payout6(now.price, strike, amount, dec);
    const left = expiry - Math.floor(Date.now() / 1000);
    const ended = left <= 0;

    $("#c-asset").textContent = asset;
    $("#c-id").textContent = "Freeze card #" + id;
    freezeText($("#c-frozen"), dropCents(usd8(strike)), 1100);
    $("#c-amount").textContent = units(amount, dec, 6) + " " + asset + " (" + usd6(unitsToUsd6(amount, strike, dec)) + " at the frozen price)";
    $("#c-now").textContent = usd8(now.price);
    $("#c-worth").textContent = usd6(worth6);
    $("#c-fee").textContent = usd6(fee6);
    $("#c-even").textContent = usd8(breakEven1e8(strike, fee6, amount, dec));
    $("#c-left").textContent = ended ? "Ended " + fmtDuration(-left) + " ago" : fmtDuration(left) + " left";
    $("#c-end").textContent = new Date(expiry * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
    const ol = $("#c-owner");
    ol.textContent = shortAddr(owner);
    ol.href = arbiscan("address", owner);
    $("#c-scan").href = arbiscan("token", HEGIC.cards + "?a=" + id);
    $("#card").classList.toggle("is-ended", ended);
    $("#c-state").textContent = ended ? "Ended" : (worth6 > 0n ? "Paying now" : "Waiting");
    $("#c-read").textContent = "Read live from Arbitrum at " + clock() + ".";
    $("#c-note").textContent = ended
      ? "This freeze is over. Any payout had to be taken before it ended."
      : worth6 > 0n
        ? "The price is above the frozen price, so the owner can take " + usd6(worth6) + " in USDC."
        : "The price is not above the frozen price yet, so it pays nothing today. It can still change before the end date.";
    const text = "My " + asset + " is frozen at " + dropCents(usd8(strike)) + ". " + (ended ? "Ended. " : fmtDuration(left) + " left. ") + "Worth " + usd6(worth6) + " right now. I paid " + usd6(fee6) + " to lock it.";
    $("#c-share").href = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(text) + "&url=" + encodeURIComponent(location.href);
    show("#state-card");
  } catch (x) {
    $("#err-text").textContent = x.message;
    show("#state-error");
  }
}
$("#retry").addEventListener("click", load);
load();
