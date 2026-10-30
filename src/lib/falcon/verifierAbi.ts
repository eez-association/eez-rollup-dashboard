export const verifierAbi = [{
  type: 'function', name: 'verify', stateMutability: 'pure',
  inputs: [{ name: 'message', type: 'bytes' }, { name: 'signature', type: 'bytes' }, { name: 'publicKey', type: 'bytes' }],
  outputs: [{ name: '', type: 'bool' }],
}] as const;
