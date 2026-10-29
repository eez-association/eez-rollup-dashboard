// Credentials and the fixed provider URL belong only to this backend module.
// Never propagate provider response/error text: it may echo the credential URL.
export class Etherscan {
  constructor(fetcher = fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    this.fetcher = fetcher; this.pause = pause; this.nextRequest = 0;
  }
  async request(key, chainId, action, fields = {}, submit = false) {
    await this.pause(Math.max(0, this.nextRequest - Date.now()));
    this.nextRequest = Date.now() + 600;
    const url = new URL('https://api.etherscan.io/v2/api');
    url.search = new URLSearchParams({ apikey: key, chainid: String(chainId), module: 'contract', action });
    const options = { signal: AbortSignal.timeout(20_000), redirect: 'error' };
    if (submit) {
      options.method = 'POST'; options.headers = { 'content-type': 'application/x-www-form-urlencoded' };
      options.body = new URLSearchParams(fields).toString();
    } else for (const [name, value] of Object.entries(fields)) url.searchParams.set(name, value);
    try {
      const response = await this.fetcher(url.href, options);
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (!['0', '1'].includes(result.status)) throw new Error();
      return result;
    } catch { throw new Error('Etherscan is unavailable; publication will retry'); }
  }
  async publish(key, chainId, contract, artifact, input, now, save) {
    contract.explorerUrl = `https://etherscan.io/address/${contract.address}#code`;
    contract.status = 'pending'; contract.explorer = 'pending';
    const source = await this.request(key, chainId, 'getsourcecode', { address: contract.address });
    if (source.status !== '1' || !Array.isArray(source.result))
      throw new Error('Etherscan source lookup failed; check the server API key and quota');
    const info = source.result[0];
    // SimilarMatch may expose another address's sources and ABI.
    if (info?.SourceCode?.trim() && typeof info.SimilarMatch === 'string'
      && (!info.SimilarMatch || /^0x0{40}$/i.test(info.SimilarMatch))) {
      contract.status = 'verified'; contract.explorer = 'verified'; delete contract.error; return;
    }
    if (contract.etherscanGuid) {
      const status = await this.request(key, chainId, 'checkverifystatus', { guid: contract.etherscanGuid });
      if (status.status === '1' && status.result === 'Pass - Verified') {
        contract.status = 'verified'; contract.explorer = 'verified'; delete contract.error; return;
      }
      if (/pending|queue|rate limit|timeout/i.test(String(status.result))) return;
      delete contract.etherscanGuid;
      throw new Error('Etherscan verification did not complete; retained sources will be retried');
    }
    if (contract.etherscanSubmittedAt && now - contract.etherscanSubmittedAt < 15 * 60_000) return;
    const submitted = await this.request(key, chainId, 'verifysourcecode', {
      contractaddress: contract.address, sourceCode: JSON.stringify(input),
      contractname: artifact.target, compilerversion: `v${artifact.compiler}`,
      codeformat: 'solidity-standard-json-input',
    }, true);
    if (submitted.status !== '1' || typeof submitted.result !== 'string'
      || !/^[a-z\d]{10,128}$/i.test(submitted.result) || submitted.result.includes(key))
      throw new Error('Etherscan did not accept the sources; check API credentials, quota and compiler support');
    contract.etherscanGuid = submitted.result; contract.etherscanSubmittedAt = now;
    save();
  }
}
