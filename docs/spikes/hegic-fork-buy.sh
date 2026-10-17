#!/usr/bin/env bash
# Spike: buy a real Hegic ETH call ("freeze") on a local fork of Arbitrum mainnet.
set -u
R=http://127.0.0.1:8546
OT=0xec096ea6eB9aa5ea689b0CF00882366E92377371      # OperationalTreasury
PM=0x5Fe380D68fEe022d8acd42dc4D36FbfB249a76d5      # PositionsManager (ERC-721 freeze cards)
S=0x2727B807D22fCAeB7F900F49894054Ed92b9125B       # ETH call strategy (60-90 days)
USDCE=0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8
WHALE=0x489ee077994B6658eAfA855C308275EAd8097C4A
BUYER=0x1111111111111111111111111111111111111111
AMOUNT=40000000000000000   # 0.04 ETH
PERIOD=$((60*86400))       # 60 days

for i in $(seq 1 30); do cast block-number --rpc-url $R >/dev/null 2>&1 && break; sleep 2; done
echo "fork block: $(cast block-number --rpc-url $R)"

# fund the test buyer: gas + 20 USDC.e
cast rpc anvil_setBalance $BUYER 0x56BC75E2D63100000 --rpc-url $R >/dev/null
cast rpc anvil_impersonateAccount $WHALE --rpc-url $R >/dev/null
cast rpc anvil_setBalance $WHALE 0x56BC75E2D63100000 --rpc-url $R >/dev/null
cast send $USDCE "transfer(address,uint256)" $BUYER 20000000 --from $WHALE --unlocked --rpc-url $R >/dev/null
echo "buyer USDC.e before: $(cast call $USDCE 'balanceOf(address)(uint256)' $BUYER --rpc-url $R | head -1)"

QUOTE=$(cast call $S 'calculateNegativepnlAndPositivepnl(uint256,uint256,bytes[])(uint128,uint128)' $AMOUNT $PERIOD '[]' --rpc-url $R | tail -1 | awk '{print $1}')
echo "quoted fee (USDC.e, 6dp): $QUOTE"

cast rpc anvil_impersonateAccount $BUYER --rpc-url $R >/dev/null
cast send $USDCE "approve(address,uint256)" $OT 20000000 --from $BUYER --unlocked --rpc-url $R >/dev/null && echo "approve OK"
TX=$(cast send $OT "buy(address,address,uint256,uint256,bytes[])" $S $BUYER $AMOUNT $PERIOD '[]' --from $BUYER --unlocked --rpc-url $R --json)
echo "$TX" | python -c "import sys,json;d=json.load(sys.stdin);print('buy status',d.get('status'),'gas',int(d.get('gasUsed','0x0'),16))"

echo "buyer USDC.e after: $(cast call $USDCE 'balanceOf(address)(uint256)' $BUYER --rpc-url $R | head -1)"
N=$(cast call $PM 'balanceOf(address)(uint256)' $BUYER --rpc-url $R | head -1)
echo "freeze cards owned by buyer: $N"
ID=$(cast call $PM 'tokenOfOwnerByIndex(address,uint256)(uint256)' $BUYER 0 --rpc-url $R 2>/dev/null | head -1)
[ -z "$ID" ] && ID=$(cast call $PM 'nextTokenId()(uint256)' --rpc-url $R 2>/dev/null | head -1)
echo "card id: $ID owner: $(cast call $PM 'ownerOf(uint256)(address)' $ID --rpc-url $R 2>&1 | head -1)"
echo "lockedLiquidity: $(cast call $OT 'lockedLiquidity(uint256)(uint8,address,uint128,uint128,uint32)' $ID --rpc-url $R | tr '\n' ' ')"
echo "strategyData (amount, strike): $(cast call $S 'strategyData(uint256)(uint128,uint128)' $ID --rpc-url $R | tr '\n' ' ')"
echo "payOffAmount now: $(cast call $S 'payOffAmount(uint256)(uint256)' $ID --rpc-url $R | head -1)"
echo "$ID" > last_id.txt
