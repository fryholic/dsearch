import {StateStore} from '@dsearch/catalog';
import {DsearchError} from '@dsearch/contracts';
type Registry={pins:Map<string,Map<string,number>>;deleting:Set<string>;maintenance:boolean};
const registries=new WeakMap<StateStore,Registry>();
const registry=(state:StateStore)=>{let value=registries.get(state);if(!value){value={pins:new Map(),deleting:new Set(),maintenance:false};registries.set(state,value);}return value;};
export function pinGeneration(state:StateStore,id:string,reason:string):()=>void{
 const r=registry(state);if(r.maintenance&&reason!=='reader')throw new DsearchError('BUSY');if(r.deleting.has(id))throw new DsearchError('BUSY');
 const counts=r.pins.get(id)??new Map<string,number>();counts.set(reason,(counts.get(reason)??0)+1);r.pins.set(id,counts);let released=false;
 return ()=>{if(released)return;released=true;const n=(counts.get(reason)??1)-1;if(n)counts.set(reason,n);else counts.delete(reason);if(!counts.size)r.pins.delete(id);};
}
export const generationPins=(state:StateStore,id:string):string[]=>[...(registry(state).pins.get(id)?.keys()??[])];
export function claimGenerationDeletion(state:StateStore,id:string):()=>void{
 const r=registry(state);if(r.deleting.has(id)||generationPins(state,id).length)throw new DsearchError('BUSY');r.deleting.add(id);return ()=>r.deleting.delete(id);
}

export const maintenanceActive=(state:StateStore)=>registry(state).maintenance;
export function beginMaintenance(state:StateStore):()=>void{
 const r=registry(state);if(r.maintenance||[...r.pins.values()].some(counts=>[...counts.keys()].some(reason=>reason!=='reader')))throw new DsearchError('BUSY');r.maintenance=true;return ()=>{r.maintenance=false;};
}
