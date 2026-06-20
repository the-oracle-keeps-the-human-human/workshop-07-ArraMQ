// ARRA-MQ PoC — proves the "all three" the cohort said nobody had, under restart:
//   (1) topic-in-signed-body  (2) real EIP-712  (3) PERSISTED seq (survives restart)
// run: bun install && bun demo.ts
import { privateKeyToAccount } from 'viem/accounts'
import { recoverTypedDataAddress } from 'viem'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs'

const DOMAIN = { name: 'ARRA-MQTT', version: '1', chainId: 20260619 } as const
const TYPES  = { Msg: [
  { name: 'topic', type: 'string' }, { name: 'data', type: 'string' },
  { name: 'ts', type: 'uint256' },   { name: 'seq', type: 'uint256' } ] } as const

// (3) persisted seq store — simulates CF Durable Object / Redis. Survives restart.
class SeqStore {
  private m: Record<string, string>
  constructor(private path: string) { this.m = existsSync(path) ? JSON.parse(readFileSync(path,'utf8')) : {} }
  commitIfNewer(addr: string, seq: bigint): boolean {            // atomic check-and-set
    const k = addr.toLowerCase(), last = BigInt(this.m[k] ?? '-1')
    if (seq <= last) return false
    this.m[k] = seq.toString(); writeFileSync(this.path, JSON.stringify(this.m)); return true
  }
}
const acct = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const sign = (topic:string,data:string,ts:bigint,seq:bigint) =>
  acct.signTypedData({ domain:DOMAIN, types:TYPES, primaryType:'Msg', message:{topic,data,ts,seq} })

async function verify(deliveryTopic:string, p:any, store:SeqStore, maxAgeMs=300_000) {
  const addr = await recoverTypedDataAddress({ domain:DOMAIN, types:TYPES, primaryType:'Msg',
    message:{ topic:p.topic, data:p.data, ts:BigInt(p.ts), seq:BigInt(p.seq) }, signature:p.sig })
  if (p.expectAddr && addr.toLowerCase()!==p.expectAddr.toLowerCase()) return {ok:false,why:'BAD_SIG'}
  if (p.topic !== deliveryTopic)                       return {ok:false,why:'BAD_TOPIC (reroute)'}  // (1)
  if (Date.now()-Number(p.ts) > maxAgeMs)              return {ok:false,why:'STALE'}
  if (!store.commitIfNewer(addr, BigInt(p.seq)))       return {ok:false,why:'REPLAY (seq<=last)'}   // (3)
  return {ok:true, addr}
}

const DB='/tmp/arra_seq.json'; try{rmSync(DB)}catch{}
let pass=0, fail=0; const t=(n:string,c:boolean)=>{console.log((c?'  PASS ':'  FAIL ')+n); c?pass++:fail++}
const topic='sensors/'+acct.address

console.log('ARRA-MQ PoC — topic-binding + EIP-712 + persisted seq\n')
let store=new SeqStore(DB)
const ts=BigInt(Date.now())
const sig1=await sign(topic,'temp=27.4',ts,1n)
t('valid msg (seq 1) accepted', (await verify(topic,{topic,data:'temp=27.4',ts:ts.toString(),seq:'1',sig:sig1,expectAddr:acct.address},store)).ok)
t('tampered data -> BAD_SIG', (await verify(topic,{topic,data:'temp=99.9',ts:ts.toString(),seq:'1',sig:sig1,expectAddr:acct.address},store)).why==='BAD_SIG')
t('rerouted delivery topic -> BAD_TOPIC', (await verify('sensors/EVIL',{topic,data:'temp=27.4',ts:ts.toString(),seq:'1',sig:sig1},store)).why?.startsWith('BAD_TOPIC')??false)
t('replay seq 1 -> REPLAY', (await verify(topic,{topic,data:'temp=27.4',ts:ts.toString(),seq:'1',sig:sig1},store)).why?.startsWith('REPLAY')??false)
const ts2=BigInt(Date.now()), sig2=await sign(topic,'temp=27.5',ts2,2n)
t('higher seq 2 accepted', (await verify(topic,{topic,data:'temp=27.5',ts:ts2.toString(),seq:'2',sig:sig2},store)).ok)

console.log('\n  -- simulate verifier RESTART (reload seq from disk) --')
store=new SeqStore(DB)   // fresh instance = restart; reads persisted state
const tsR=BigInt(Date.now()); const sig1b=await sign(topic,'temp=27.4',tsR,1n)
t('after restart: replay old seq 1 STILL rejected (persisted)', (await verify(topic,{topic,data:'temp=27.4',ts:tsR.toString(),seq:'1',sig:sig1b,expectAddr:acct.address},store)).why?.startsWith('REPLAY')??false)
const ts3=BigInt(Date.now()), sig3=await sign(topic,'temp=27.6',ts3,3n)
t('after restart: new seq 3 accepted', (await verify(topic,{topic,data:'temp=27.6',ts:ts3.toString(),seq:'3',sig:sig3},store)).ok)

console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(fail?1:0)
