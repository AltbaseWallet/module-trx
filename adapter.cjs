'use strict'
const { TronWeb } = require('tronweb')
const { Interface, AbiCoder } = require('ethers')
const { unsigned, parseAmount } = require('../account-common/amounts.cjs')
const { keyFor } = require('../account-common/keys.cjs')
const ABI = new Interface(['function decimals() view returns(uint8)', 'function symbol() view returns(string)', 'function name() view returns(string)', 'function balanceOf(address) view returns(uint256)'])
function tronAdapter(config, transport) {
  const read = transport.tron
  const web = new TronWeb({ fullHost: transport.url })
  // SDK construction/signing stays local. All network I/O goes through the
  // bounded PublicNode transport and its method allowlist.
  web.fullNode.request = () => { throw Error('Unexpected SDK network request') }
  web.solidityNode.request = web.fullNode.request
  const normalize = value => { if (!TronWeb.isAddress(value)) throw Error('Invalid Tron address'); return TronWeb.address.fromHex(TronWeb.address.toHex(value)) }
  let identity = null, identityValidUntil = 0, pendingHead = null
  async function verifyNetwork() {
    if (Date.now() < identityValidUntil) return
    identity ||= (async () => {
      const genesis = await read('/wallet/getblock', { id_or_num: '0', detail: false })
      if (genesis.blockID !== config.genesis) throw Error('Unexpected Tron network')
      identityValidUntil = Date.now() + 300000
    })().finally(() => { identity = null })
    return identity
  }
  function head() {
    pendingHead ||= (async () => {
      await verifyNetwork()
      // getnowblock downloads every transaction just to read a height. A busy
      // block can exceed the bounded response or request time limit.
      const block = await read('/walletsolidity/getblock', { detail: false }), height = block.block_header?.raw_data?.number
      if (!Number.isSafeInteger(height) || height < 0 || !/^[a-f0-9]{64}$/i.test(block.blockID)) throw Error('Tron finalized height unavailable')
      return { height, block }
    })().finally(() => { pendingHead = null })
    return pendingHead
  }
  async function account(owner, route = '/walletsolidity/getaccount') {
    owner = normalize(owner)
    const value = await read(route, { address: owner, visible: true })
    if (Object.keys(value).length && (!value.address || normalize(value.address) !== owner)) throw Error('Tron account identity is unavailable')
    return value
  }
  async function call(contract, selector, parameter, owner, route = '/walletsolidity/triggerconstantcontract') {
    const response = await read(route, { owner_address: owner, contract_address: contract, function_selector: selector, parameter, visible: true })
    if (response.result?.result !== true || !Array.isArray(response.constant_result) || !/^[a-f0-9]+$/i.test(response.constant_result[0])) throw Error('Tron token read failed')
    return '0x' + response.constant_result[0]
  }
  async function token(contract, owner, block, previous = {}) {
    void block // Finalized Tron reads select their own solidity-node context.
    if (/^trc10:[1-9]\d{0,15}$/.test(contract)) {
      const number = contract.slice(6), data = await read('/wallet/getassetissuebyid', { value: number })
      data.precision ??= 0
      if (String(data.id) !== number || !Number.isInteger(data.precision) || data.precision < 0 || data.precision > 18) throw Error('Invalid TRC-10 asset')
      const holdings = (await account(owner)).assetV2 || []
      if (!Array.isArray(holdings)) throw Error('Invalid TRC-10 holdings')
      return { id: contract, name: Buffer.from(data.name || '', 'hex').toString('utf8'), symbol: Buffer.from(data.abbr || '', 'hex').toString('utf8'), decimals: data.precision,
        atomic: unsigned(holdings.find(x => x.key === number)?.value ?? 0, { bits: 64 }).toString(), complete: true, standard: 'TRC-10' }
    }
    contract = normalize(contract)
    const parameter = AbiCoder.defaultAbiCoder().encode(['address'], ['0x' + TronWeb.address.toHex(owner).slice(2)]).slice(2)
    const readField = (method, args = '') => call(contract, method + (method === 'balanceOf' ? '(address)' : '()'), args, owner).then(x => ABI.decodeFunctionResult(method, x)[0])
    const [atomic, rawDecimals, rawSymbol, rawName] = await Promise.all([
      readField('balanceOf', parameter), readField('decimals'), readField('symbol').catch(() => null), readField('name').catch(() => null),
    ])
    const decimals = Number(rawDecimals), sameToken = previous.id === contract
    const symbol = rawSymbol ?? (sameToken ? previous.symbol : null) ?? contract.slice(0, 10)
    const name = rawName ?? (sameToken ? previous.name : null) ?? symbol
    return { id: contract, name, symbol, decimals, atomic: unsigned(atomic.toString()).toString(), complete: true, standard: 'TRC-20' }
  }
  async function discover(owner) {
    const data = await account(owner), holdings = data.assetV2 || []
    if (!Array.isArray(holdings)) throw Error('Invalid Tron asset inventory')
    return { candidates: holdings.map(row => 'trc10:' + row.key), complete: false, reason: 'trc20-history-not-indexed' }
  }
  async function prepare({ owner, to, amount, asset, max }) {
    owner = normalize(owner); to = normalize(to)
    if (owner === to) throw Error('Choose a different Tron recipient')
    const [current, resourcePrices, ownerAccount] = await Promise.all([
      read('/wallet/getnowblock'), read('/wallet/getchainparameters'), account(owner, '/wallet/getaccount'),
    ])
    const raw = current.block_header?.raw_data
    if (!Number.isSafeInteger(raw?.number) || !Number.isSafeInteger(raw.timestamp) || !/^[a-f0-9]{64}$/i.test(current.blockID)) throw Error('Tron reference block unavailable')
    const blockHeader = { ref_block_bytes: raw.number.toString(16).padStart(4, '0').slice(-4), ref_block_hash: current.blockID.slice(16, 32), timestamp: raw.timestamp, expiration: raw.timestamp + 60000 }
    const parameters = resourcePrices.chainParameter
    if (!Array.isArray(parameters)) throw Error('Tron resource prices unavailable')
    const price = key => { const row = parameters.find(x => x.key === key); if (!row) throw Error('Tron resource price unavailable'); return unsigned(row.value ?? 0) }
    const native = unsigned(ownerAccount.balance ?? 0, { bits: 64 })
    let atomic = max ? 1n : parseAmount(amount, asset?.decimals ?? 6, { bits: asset?.standard === 'TRC-20' ? 256 : 64 })
    if (asset) {
      // Spendable units come from the current full node, not a second round of
      // finalized metadata reads. Pending debits must reduce MAX as well.
      const parameter = asset.standard === 'TRC-20' ? AbiCoder.defaultAbiCoder().encode(['address'], ['0x' + TronWeb.address.toHex(owner).slice(2)]).slice(2) : null
      const available = asset.standard === 'TRC-20'
        ? unsigned(ABI.decodeFunctionResult('balanceOf', await call(asset.id, 'balanceOf(address)', parameter, owner, '/wallet/triggerconstantcontract'))[0].toString())
        : unsigned((ownerAccount.assetV2 || []).find(row => row.key === asset.id.slice(6))?.value ?? 0, { bits: 64 })
      if (max) atomic = available
      if (atomic > available) throw Error('Insufficient token balance')
    }
    let energyFee = 0n
    if (asset?.standard === 'TRC-20') {
      const parameter = AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], ['0x' + TronWeb.address.toHex(to).slice(2), atomic]).slice(2)
      const simulation = await read('/wallet/triggerconstantcontract', { owner_address: owner, contract_address: asset.id, function_selector: 'transfer(address,uint256)', parameter, visible: true })
      if (simulation.result?.result !== true || !Number.isSafeInteger(simulation.energy_used) || simulation.energy_used < 1) throw Error('Tron transfer simulation unavailable')
      if (simulation.constant_result?.[0] && BigInt('0x' + simulation.constant_result[0]) === 0n) throw Error('Token rejected transfer simulation')
      energyFee = (BigInt(simulation.energy_used) * price('getEnergyFee') * 150n + 99n) / 100n
    }
    const make = async value => {
      if (asset?.standard === 'TRC-20') {
        if (energyFee > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Tron fee exceeds supported range')
        const result = await web.transactionBuilder.triggerSmartContract(asset.id, 'transfer(address,uint256)',
          { txLocal: true, blockHeader, feeLimit: Number(energyFee) }, [{ type: 'address', value: to }, { type: 'uint256', value: value.toString() }], owner)
        return result.transaction
      }
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Tron SDK cannot encode this amount without precision loss')
      return asset ? web.transactionBuilder.sendToken(to, Number(value), asset.id.slice(6), owner, { blockHeader })
        : web.transactionBuilder.sendTrx(to, Number(value), owner, { blockHeader })
    }
    if (atomic <= 0n) throw Error('Amount must be positive')
    let transaction = await make(atomic)
    const recipient = await account(to, '/wallet/getaccount')
    const activation = recipient.address || asset?.standard === 'TRC-20' ? 0n : price('getCreateNewAccountFeeInSystemContract') + price('getCreateAccountFee')
    // Ignore available free/staked resources for a conservative burn ceiling.
    // Extra 256 bytes covers signatures/envelope and MAX varint growth.
    const fee = energyFee + BigInt(transaction.raw_data_hex.length / 2 + 256) * price('getTransactionFee') + activation
    if (max && !asset) { atomic = native > fee ? native - fee : 0n; if (atomic > 0n) transaction = await make(atomic) }
    if (!atomic || native < fee + (asset ? 0n : atomic)) throw Error('Insufficient TRX including maximum resource cost')
    return { atomic: atomic.toString(), feeAtomic: fee.toString(), nativeRequired: fee.toString(), unsigned: transaction }
  }
  async function sign(plan, mnemonic) {
    if (!Number.isSafeInteger(plan.unsigned?.raw_data?.expiration) || plan.unsigned.raw_data.expiration <= Date.now() + 2000) throw Error('Tron reference block expired')
    const key = keyFor('tron', mnemonic)
    if (key.address !== plan.owner) throw Error('Transfer wallet changed')
    const signed = await web.trx.sign(plan.unsigned, key.privateKey)
    return { serialized: signed, txid: plan.unsigned.txID }
  }
  async function receipt(txid) {
    const data = await read('/wallet/gettransactioninfobyid', { value: txid })
    if (!data.id) return 'unknown'
    if (data.id !== txid || !Number.isSafeInteger(data.blockNumber)) throw Error('Invalid Tron receipt')
    const tip = await read('/walletsolidity/getblock', { detail: false })
    if (!Number.isSafeInteger(tip.block_header?.raw_data?.number)) throw Error('Tron finalized height unavailable')
    if (tip.block_header.raw_data.number < data.blockNumber) return 'submitted'
    return data.result === 'FAILED' || (data.receipt?.result && data.receipt.result !== 'SUCCESS') ? 'failed' : 'confirmed'
  }
  return { normalize: value => /^trc10:[1-9]\d{0,15}$/.test(value) ? value : normalize(value), validate: TronWeb.isAddress,
    head, token, discover, prepare, sign, receipt, balance: async owner => unsigned((await account(owner)).balance ?? 0, { bits: 64 }).toString() }
}
module.exports = { tronAdapter }
