const { parseAbi, decodeFunctionData, encodeFunctionResult, keccak256, toHex } = require('viem');
const abi = parseAbi(['function composerInfo(bytes32 nonce) view returns (bytes32 marker,uint256 schemaVersion,bytes32 echoedNonce,uint256 sourceChainId,bytes info)']);
// Mock only: echo the request nonce and selected chain, just as discovery requires.
function composerResponse(data, chain, l1 = '0x27d8', l2 = '0x1892', contracts) {
  const { args } = decodeFunctionData({ abi, data });
  const address = '0x' + '33'.repeat(20);
  return encodeFunctionResult({ abi, functionName: 'composerInfo', result: [
    keccak256(toHex('EEZ_COMPOSER_DISCOVERY')), 1n, args[0], BigInt(chain),
    toHex(JSON.stringify({ version: 'fixture', supportedNetworks: { eezL1: Number(BigInt(l1)), eezL2: Number(BigInt(l2)) },
      eezContracts: contracts ?? { eezRegistryAddress: address, eezL2Address: address } })),
  ] });
}
module.exports = { composerResponse };
