import { snapshotBundleSchema,snapshotHash,type HumanContext,type WorkflowRepository,type Item } from '@vera/workflow-data';
import type {ArtifactIO} from './artifacts.js';
const states=['draft','checked','draft_failed','content_review','content_approved','build_failed','built','test_failed','tested','deploy_review','deploy_approved','rejected','deploying','deployed'];
export class HistoryService {
 constructor(private workflow:WorkflowRepository,private artifacts:ArtifactIO){}
 async list(ctx:HumanContext){
  const items:Item[]=[];
  for(const state of states){let cursor:Item|undefined;do{
   const {QueryCommand}=await import('@aws-sdk/lib-dynamodb');const result=await this.workflow.client.send(new QueryCommand({TableName:this.workflow.tables.changes,IndexName:'ReviewInboxIndex',KeyConditionExpression:'inbox = :i',ExpressionAttributeValues:{':i':`${ctx.tenantId}#${state}`},Limit:100,ExclusiveStartKey:cursor,ScanIndexForward:false}));
   items.push(...(result.Items??[]).filter(r=>r.sk==='META').map(r=>({changeId:r.changeId,pathwayId:r.pathwayId,state:r.state,snapshotHash:r.snapshotHash,updatedAt:r.updatedAt})));cursor=result.LastEvaluatedKey;
  }while(cursor);}
  return {items:items.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))};
 }
 async read(ctx:HumanContext,changeId:string){
  const current=await this.workflow.getChange(ctx,changeId);const incompleteSources:string[]=[];
  const load=async(name:string,fn:()=>Promise<Item[]>)=>{try{return await fn();}catch{incompleteSources.push(name);return[];}};
  const rows=async(table:string,prefix?:string)=>{const items:Item[]=[];let cursor:Item|undefined;do{const p=await this.workflow.query(table,changeId,prefix,cursor);items.push(...p.items);cursor=p.cursor;}while(cursor);return items;};
  const [events,decisions,snapshots,builds,tests,referrals,requests]=await Promise.all([
   load('Audit',()=>rows(this.workflow.tables.audit)),load('Approvals',()=>this.workflow.listDecisions(ctx,changeId)),load('Snapshots',()=>rows(this.workflow.tables.changes,'SNAPSHOT#')),load('Build records',()=>rows(this.workflow.tables.changes,'BUILD#')),load('Test records',()=>rows(this.workflow.tables.changes,'TEST#')),load('Clinician referrals',()=>rows(this.workflow.tables.changes,'REFERRAL#')),load('Pipeline requests',()=>rows(this.workflow.tables.changes,'REQUEST#'))]);
  const verified=[];
  for(const s of snapshots){let integrity='verified';try{const b=snapshotBundleSchema.parse(JSON.parse(Buffer.from(await this.artifacts.getArtifactVersion(s.artifact)).toString()));if(snapshotHash(b)!==s.snapshotHash)throw Error();}catch{integrity='failed';incompleteSources.push(`Snapshot ${s.snapshotId}`);}verified.push({snapshotId:s.snapshotId,snapshotHash:s.snapshotHash,parentSnapshotHash:s.parentSnapshotHash??null,authorId:s.authorId,origin:s.origin??'not recorded',designation:s.designation??'not recorded',createdAt:s.createdAt,integrity});}
  return {current:{changeId,state:current.state,snapshotHash:current.snapshotHash,pathwayId:current.pathwayId},snapshots:verified,decisions:decisions.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)),events:events.map(e=>({type:e.type,actorId:e.actorId,createdAt:e.createdAt,snapshotHash:e.snapshotHash,fromState:e.fromState,toState:e.toState})),builds:builds.map(b=>({buildId:b.buildId,snapshotHash:b.snapshotHash,buildKind:b.buildKind,createdAt:b.createdAt,artifactDigest:b.artifactDigest})),tests:tests.map(t=>({buildId:t.buildId,snapshotHash:t.snapshotHash,summary:t.summary,createdAt:t.createdAt})),referrals:referrals.map(r=>({snapshotHash:r.snapshotHash,actorId:r.actorId,createdAt:r.createdAt})),requests:requests.map(r=>({requestId:r.requestId,type:r.type,status:r.status,snapshotHash:r.snapshotHash,actorId:r.actorId,createdAt:r.createdAt})),incompleteSources};
 }
}
