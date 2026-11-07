import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const result=await build({entryPoints:['src/main.js'],bundle:true,write:false,format:'iife',minify:true,legalComments:'inline'});
const template=await readFile('src/template.html','utf8');
await writeFile('index.html',template.replace('/* APP */',()=>result.outputFiles[0].text.replaceAll('</script','<\\/script')));
console.log('Built standalone index.html');
