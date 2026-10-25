import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {createServer} from 'vite';import react from '@vitejs/plugin-react';import {chromium} from 'playwright';
import {sharedDeploymentKey,sharedManifestKey} from '../src/lib/treasury/deployment.ts';
const server=await createServer({configFile:false,envFile:false,plugins:[react()],server:{host:'127.0.0.1',port:0},base:'/'});await server.listen();
const origin=`http://127.0.0.1:${server.httpServer.address().port}`,browser=await chromium.launch({headless:true,chromiumSandbox: true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',async route=>{const url=new URL(route.request().url());assert.equal(url.origin,origin);
 if(url.pathname==='/setup')return route.fulfill({contentType:'text/html',body:'<!doctype html><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>'});return route.continue();});
try{
 await page.goto(`${origin}/setup`);await page.evaluate(async keys=>{for(const key of keys)localStorage.setItem(key,'retained Chiado state');const m=await import('/tests/fixtures/treasury-mainnet-setup.tsx');m.mount();},[sharedDeploymentKey,sharedManifestKey]);
 await page.getByRole('heading',{name:'Choose your Safes',exact:true}).waitFor();
 assert.equal(await page.getByText('both Safes stay in sync automatically.',{exact:true}).count(),1);
 assert.equal(await page.getByRole('button',{name:'Get Test USDC',exact:true}).count(),0);
 await page.getByLabel('Ethereum Safe address',{exact:true}).fill('0x0000000000000000000000000000000000000064');
 await page.getByLabel('EEZ-X Safe',{exact:true}).selectOption('existing');
 await page.getByLabel('Mirror Safe address',{exact:true}).fill('0x0000000000000000000000000000000000000065');
 await page.getByRole('button',{name:'Start setup',exact:true}).click();
 await page.getByRole('alert').getByText('Fixture stopped before network validation',{exact:true}).waitFor();
 const selected=await page.evaluate(()=>window.selection);assert.equal(selected.safeL1.toLowerCase(),'0x0000000000000000000000000000000000000064');assert.equal(selected.safeL2.toLowerCase(),'0x0000000000000000000000000000000000000065');assert.notEqual(selected.deployer.toLowerCase(),selected.safeL1.toLowerCase());
 assert.deepEqual(await page.evaluate(keys=>keys.map(k=>localStorage.getItem(k)),[sharedDeploymentKey,sharedManifestKey]),['retained Chiado state','retained Chiado state']);
 mkdirSync('.runtime/treasury-mainnet-bridge-20261022',{recursive:true});await page.screenshot({path:'.runtime/treasury-mainnet-bridge-20261022/mainnet-safe-chooser.png',fullPage:true});
 assert.deepEqual(errors,[]);console.log('Mainnet chooser: selected Ethereum/mirror addresses, connected deployment wallet, no faucet, Chiado journals preserved.');
}finally{await page.unrouteAll({behavior:'wait'});await browser.close();await server.close();}
