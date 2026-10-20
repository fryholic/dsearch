import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";

const folder=resolve(import.meta.dirname,"../docs/design/mockups");
const files=new Set(["index.html","ia.html","app.js","ia.js","style.css","tokens.css"]);
const types={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
const port=Number(process.env.DSEARCH_MOCKUP_PORT || 4173);
const server=createServer(async(req,res)=>{
  if(req.headers.host!=="127.0.0.1:"+port && req.headers.host!=="localhost:"+port) {
    res.writeHead(403);res.end();return;
  }
  const pathname=new URL(req.url,"http://127.0.0.1").pathname;
  const file=pathname==="/"?"index.html":pathname.slice(1);
  if(!["GET","HEAD"].includes(req.method)||!files.has(file)) {
    res.writeHead(404);res.end("Not found");return;
  }
  try {
    const data=await readFile(resolve(folder,file));
    res.writeHead(200,{
      "Content-Type":types[extname(file)] || "application/octet-stream",
      "Cache-Control":"no-store",
      "Content-Security-Policy":"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      "X-Content-Type-Options":"nosniff",
      "Referrer-Policy":"no-referrer"
    });
    res.end(req.method==="HEAD"?undefined:data);
  } catch {
    res.writeHead(404);res.end("Local mockup files are not present in this checkout.");
  }
});
try { await stat(resolve(folder,"index.html")); }
catch { console.error("Local design files are absent. This repository excludes docs/.");process.exit(1); }
server.on("error",error=>{console.error(error.message);process.exit(1);});
server.listen(port,"127.0.0.1",()=>console.log("Local design mockup: http://127.0.0.1:"+port));
