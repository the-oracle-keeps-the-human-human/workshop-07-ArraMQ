import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { keccak256, stringToHex, verifyTypedData } from 'viem'
import { ARRA_MQ_DOMAIN, ARRA_MQ_TYPES } from './typed-data'

type Msg = {
  v: number
  from: `0x${string}`
  topic: string
  ts: number
  seq: number
  dataHash: `0x${string}`
  data: unknown
  sig: `0x${string}`
}

const seqFile = process.env.ARRA_MQ_SEQ_FILE ?? './last-seq.json'

function loadSeq() {
  // ponytail: JSON file is enough for one-node PoC; use SQLite/DO for cluster.
  return existsSync(seqFile) ? JSON.parse(readFileSync(seqFile, 'utf8')) : {}
}

function saveSeq(store: Record<string, number>) {
  writeFileSync(seqFile, JSON.stringify(store, null, 2))
}

export async function verifyArraMq(deliveryTopic: string, msg: Msg) {
  if (msg.topic !== deliveryTopic) throw new Error('topic mismatch')
  if (Math.abs(Date.now() / 1000 - msg.ts) > 60) throw new Error('stale message')

  const dataHash = keccak256(stringToHex(JSON.stringify(msg.data)))
  if (dataHash !== msg.dataHash) throw new Error('data hash mismatch')

  const seq = loadSeq()
  const key = `${msg.from}:${msg.topic}`
  if (msg.seq <= (seq[key] ?? 0)) throw new Error('replayed sequence')

  const ok = await verifyTypedData({
    address: msg.from,
    domain: ARRA_MQ_DOMAIN,
    types: ARRA_MQ_TYPES,
    primaryType: 'ArraMessage',
    message: {
      v: BigInt(msg.v),
      from: msg.from,
      topic: msg.topic,
      ts: BigInt(msg.ts),
      seq: BigInt(msg.seq),
      dataHash: msg.dataHash,
    },
    signature: msg.sig,
  })

  if (!ok) throw new Error('bad signature')
  seq[key] = msg.seq
  saveSeq(seq)
  return msg.data
}
