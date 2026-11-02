import { encodeAbiParameters, keccak256, parseAbi, stringToHex, type Address, type Hex } from 'viem';

export const L1_ACTION_TYPE = 'FalconL1Call(uint256 sourceChainId,uint256 destinationChainId,address controller,address eezL2,address target,bytes32 dataHash,uint256 nonce,uint256 deadline)';
export const L1_ACTION_TYPEHASH = keccak256(stringToHex(L1_ACTION_TYPE));
export type L1Action = {
  sourceChainId: bigint; destinationChainId: bigint; controller: Address;
  eezL2: Address; target: Address; data: Hex; nonce: bigint; deadline: bigint;
};
export type SignedL1Action = { action: L1Action; signature: Hex; publicKey: Hex };

export function l1ActionDigest(a: L1Action): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' },
      { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }],
    [L1_ACTION_TYPEHASH, a.sourceChainId, a.destinationChainId, a.controller, a.eezL2, a.target, keccak256(a.data), a.nonce, a.deadline],
  ));
}

export const l1ControllerAbi = parseAbi([
  'function verifier() view returns (address)', 'function eezL2() view returns (address)',
  'function l1ChainId() view returns (uint256)', 'function publicKeyHash() view returns (bytes32)',
  'function nonce() view returns (uint256)',
  'function actionDigest(address target,bytes data,uint256 authorizationNonce,uint256 deadline) view returns (bytes32)',
  'function checkAuthorization(address target,bytes data,uint256 authorizationNonce,uint256 deadline,bytes signature,bytes publicKey) view returns (bytes32)',
  'function execute(address target,bytes data,uint256 authorizationNonce,uint256 deadline,bytes signature,bytes publicKey) returns (bytes)',
  'event CallExecuted(bytes32 indexed digest,uint256 indexed nonce,address indexed target,address relayer,bytes32 signatureHash,bytes result)',
  'error InvalidConfiguration()', 'error InvalidTarget()', 'error WrongPublicKey()',
  'error InvalidNonce(uint256 expected,uint256 supplied)', 'error AuthorizationExpired()',
  'error InvalidSignature()', 'error ReentrantExecution()',
]);
export const l1ControllerFactoryAbi = parseAbi([
  'function verifier() view returns (address)', 'function eezL2() view returns (address)',
  'function l1ChainId() view returns (uint256)',
  'function controllers(bytes32 publicKeyHash) view returns (address)',
  'function createController(bytes32 publicKeyHash) returns (address)',
  'event ControllerCreated(bytes32 indexed publicKeyHash,address indexed controller)',
]);
