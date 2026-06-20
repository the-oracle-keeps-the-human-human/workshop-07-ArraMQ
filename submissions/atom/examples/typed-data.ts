export const ARRA_MQ_DOMAIN = {
  name: 'ARRA-MQTT',
  version: '1',
  chainId: 20260619,
} as const

export const ARRA_MQ_TYPES = {
  ArraMessage: [
    { name: 'v', type: 'uint256' },
    { name: 'from', type: 'address' },
    { name: 'topic', type: 'string' },
    { name: 'ts', type: 'uint256' },
    { name: 'seq', type: 'uint256' },
    { name: 'dataHash', type: 'bytes32' },
  ],
} as const
