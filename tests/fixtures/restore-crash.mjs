import {restoreBackup} from '../../apps/daemon/dist/index.js';
const [backupPath,targetRoot,planId,phase]=process.argv.slice(2);
try{await restoreBackup({backupPath,targetRoot,apply:true,planId,fault:async point=>{if(point!==phase)return;await new Promise(resolve=>process.send({phase:point},resolve));process.kill(process.pid,'SIGKILL');}});process.exit(3);}catch(error){process.send?.({error:error.code??'unexpected'});process.exit(2);}
