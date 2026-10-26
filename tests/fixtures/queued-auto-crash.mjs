import {Catalog,StateStore,canonicalJSON,digest} from '../../packages/catalog/dist/index.js';
import {GenerationBuilder,createAlphaProfile} from '../../packages/generations/dist/index.js';
import {ModelManager} from '../../apps/daemon/dist/models.js';

const [dataRoot,source,engineRoot,modelRoot]=process.argv.slice(2);
const state=await StateStore.open(dataRoot),catalog=new Catalog(state),collection=await catalog.addCollection({name:'Projects',root:source});
await catalog.reconcile(collection.collection_id);
const profile=(await createAlphaProfile(engineRoot)).manifest,fp=digest(canonicalJSON(profile)),models=await ModelManager.open(modelRoot),available=await models.availability('embed');
const automatic={origin:'automatic',automatic_key:digest(canonicalJSON([state.sourceSeq,fp,available.fingerprint])),automatic_source_seq:state.sourceSeq,automatic_profile_fp:fp};
new GenerationBuilder(catalog,{engineRoot,modelRoot,profile,embedRole:'embed'}).start({automatic});
// Kill before the deferred build starts, immediately after the queued transaction.
process.kill(process.pid,'SIGKILL');
