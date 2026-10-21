const timers=new Map();
process.on('message',message=>{
 const {id,type,payload}=message;
 const reply=(ok,value,code)=>process.send({version:1,id,type:'response',ok,value,code});
 if(type==='cancel') {const timer=timers.get(id);if(timer){clearTimeout(timer);timers.delete(id);reply(false,undefined,'CANCELLED');}return;}
 if(type!=='request')return;
 if(payload.op==='stall') {Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);reply(true,'late');}
 else if(payload.op==='wait')timers.set(id,setTimeout(()=>{timers.delete(id);reply(true,'done');},1000));
 else if(payload.op==='exit')process.exit(2);
 else {console.error('private input that must not be forwarded');reply(true,payload);}
});
