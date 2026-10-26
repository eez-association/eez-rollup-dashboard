const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = readFileSync(join(__dirname, '../ui/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function browser() {
  const elements = new Map();
  const context = vm.createContext({
    location: { pathname: '/' },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { addEventListener() {} });
      return elements.get(id);
    } },
    // Leave startup waiting for configuration; tests supply it explicitly.
    fetch: () => new Promise(() => {}),
    setInterval() {},
  });
  vm.runInContext(script, context);
  return { context, elements, run: code => vm.runInContext(code, context) };
}

test('order history is isolated by profile, chain and settlement', () => {
  const b = browser();
  b.run("cfg={network:'mainnet',l1ChainId:1,l2ChainId:696990,settlement:'0xABC'}");
  const mainnet = b.run('orderStorageKey()');
  b.run("cfg={network:'chiado',l1ChainId:10200,l2ChainId:906969,settlement:'0xABC'}");
  const chiado = b.run('orderStorageKey()');
  assert.notEqual(mainnet, chiado);
  b.run("cfg.settlement='0xDEF'");
  assert.notEqual(chiado, b.run('orderStorageKey()'));
});

test('activity links use the selected explorers and omit unconfigured links', () => {
  const b = browser();
  b.run("cfg={l1Explorer:'https://chiado.example',l2Explorer:'https://eezx.example/'}; submitted=[{id:'test',status:'settled',symbol:'TEST',sellAmount:'1',buyAmount:'1',solverDebug:{l1Tx:'0x111',txHash:'0x222'}}]; renderOrders()");
  const output = b.elements.get('orders').innerHTML;
  assert.ok(output.includes('https://chiado.example/tx/0x111'));
  assert.ok(output.includes('https://eezx.example/tx/0x222'));
  assert.ok(!output.includes('etherscan.io'));
  assert.ok(!output.includes('mainnet.eez.dev'));
  b.run('cfg.l1Explorer=null; cfg.l2Explorer=null; renderOrders()');
  assert.ok(!b.elements.get('orders').innerHTML.includes('<a '));
});
