import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCli, importFresh } from "./helpers.mjs";
const ERRORS_MODULE="../src/plugins/errors.mjs";
const LOADER_MODULE="../src/plugins/loader.mjs";
const DISPATCH_MODULE="../src/plugins/dispatch.mjs";
const RESERVED_MODULE="../src/cli/commands/reserved-namespaces.mjs";
async function freshEnv(prefix="climier-dispatch-test"){const home=await fs.mkdtemp(path.join(os.tmpdir(),
prefix+"-"));
const projectDir=await fs.mkdtemp(path.join(os.tmpdir(),"climier-dispatch-proj-"));
const prev=process.env.CLIMIER_HOME;
process.env.CLIMIER_HOME=home;
  return{home,projectDir,restore(){if(prev===void 0){delete process.env.CLIMIER_HOME}else{process.env.CLIMIER_HOME=prev}},
    async cleanup(){await fs.rm(home,{recursive:true,force:true});
await fs.rm(projectDir,{recursive:true,force:true})}}}async function seedInstalledPlugin(home,namespace,opts={}){const installedRoot=path.join(home,
"plugins","installed",namespace);
await fs.mkdir(installedRoot,{recursive:true});
  const descriptor={id:opts.id??namespace,command:opts.command??namespace,entry:opts.entry??"./climier.mjs",
api:opts.api??1};
  await fs.writeFile(path.join(installedRoot,"package.json"),JSON.stringify({name:opts.npmName??namespace,version:"1.0.0",
type:"module",climier:descriptor},null,2)+"\n","utf8");
await fs.writeFile(path.join(installedRoot,"climier.mjs"),opts.entryCode??defaultEntryCode(),"utf8");
return{installedRoot,descriptor}}function defaultEntryCode(){return"export default {\n  commands: {\n    ping: (args, api) => ({\n      ok: true,\n      command: 'ping',\n      args,\n      api_runtime: api.runtime,\n    }),\n    thrower: () => { throw new Error('handler-boom'); },\n    rethrow: () => { const e = new Error('already-plugin'); e.code = 'PLUGIN_LOAD_FAILED'; e.details = { from: 'handler' }; throw e; },\n  },\n};\n"}async function captureRejection(promise){try{await promise}catch(error){return error}assert.fail("expected promise to reject")}function testWithEnv(name,
  body,prefix="climier-dispatch-test"){test(name,async()=>{const env=await freshEnv(prefix);
    try{await body(env)}finally{env.restore();
await env.cleanup()}})}testWithEnv("plugin-errors: throwPluginError throws an Error with .code and .details",
async()=>{const{throwPluginError}=await importFresh(ERRORS_MODULE);
let caught;
try{throwPluginError("PLUGIN_HANDLER_FAILED","boom",{namespace:"x"})}catch(error){caught=error}assert.ok(caught);
assert.equal(caught.code,"PLUGIN_HANDLER_FAILED");
assert.deepEqual(caught.details,{namespace:"x"});
assert.match(caught.message,/boom/)});
testWithEnv("plugin-errors: PluginSubcommandNotFound carries namespace + subcommand in details",async()=>{const{PluginSubcommandNotFound}=await importFresh(ERRORS_MODULE);
const err=new PluginSubcommandNotFound("audit","ghost");
assert.equal(err.code,"PLUGIN_SUBCOMMAND_NOT_FOUND");
assert.equal(err.details.namespace,"audit");
assert.equal(err.details.subcommand,"ghost")});
testWithEnv("plugin-errors: PluginSubcommandNotFound allows null subcommand for missing subcommand case",async()=>{const{PluginSubcommandNotFound}=await importFresh(ERRORS_MODULE);
const err=new PluginSubcommandNotFound("audit",null);
assert.equal(err.code,"PLUGIN_SUBCOMMAND_NOT_FOUND");
assert.equal(err.details.namespace,"audit");
assert.equal(err.details.subcommand,null)});
testWithEnv("plugin-errors: PluginHandlerFailed carries plugin_id, namespace, subcommand, cause in details",
async()=>{const{PluginHandlerFailed}=await importFresh(ERRORS_MODULE);
const cause=new Error("handler exploded");
const err=new PluginHandlerFailed("audit","run",cause);
assert.equal(err.code,"PLUGIN_HANDLER_FAILED");
assert.equal(err.details.plugin_id,"audit");
assert.equal(err.details.namespace,"audit");
assert.equal(err.details.subcommand,"run");
assert.match(err.details.cause,/handler exploded/)});
testWithEnv("plugin-loader: loadInstalledPlugin returns descriptor + commands for a valid installed plugin",
async env=>{await seedInstalledPlugin(env.home,"audit");
const{loadInstalledPlugin}=await importFresh(LOADER_MODULE);
const loaded=await loadInstalledPlugin("audit");
assert.equal(loaded.pluginId,"audit");
assert.equal(loaded.descriptor.api,1);
assert.equal(loaded.descriptor.id,"audit");
assert.equal(loaded.descriptor.command,"audit");
assert.equal(typeof loaded.commands.ping,"function");
assert.equal(typeof loaded.commands.thrower,"function");
assert.ok(loaded.entryPath.endsWith(path.join("installed","audit","climier.mjs")))});
testWithEnv("plugin-loader: rejects an incompatible descriptor before importing its entrypoint",async env=>{const installedRoot=path.join(env.home,
"plugins","installed","future");
await fs.mkdir(installedRoot,{recursive:true});
const marker=path.join(env.home,"imported");
  await fs.writeFile(path.join(installedRoot,"package.json"),JSON.stringify({name:"future",version:"1.0.0",type:"module",
climier:{id:"future",command:"future",api:3,entry:"./climier.mjs"}},null,2)+"\n","utf8");
await fs.writeFile(path.join(installedRoot,"climier.mjs"),`import "node:fs";
await import("node:fs/promises").then((fs) => fs.writeFile(${JSON.stringify(marker)}, "imported"));
export default { commands: {} };
`,
"utf8");
const{loadInstalledPlugin}=await importFresh(LOADER_MODULE);
const error=await captureRejection(loadInstalledPlugin("future"));
assert.equal(error.code,"PLUGIN_API_INCOMPATIBLE");
assert.equal(error.details.received,3);
assert.match(error.message,/api: 1/);
assert.match(error.message,/update.*reinstall|reinstall.*update/i);
const markerError=await captureRejection(fs.access(marker));
assert.equal(markerError.code,"ENOENT")});
testWithEnv("plugin-loader: loadInstalledPlugin throws PLUGIN_LOAD_FAILED when installed dir is missing",async()=>{const{loadInstalledPlugin}=await importFresh(LOADER_MODULE);
const error=await captureRejection(loadInstalledPlugin("ghost"));
assert.equal(error.code,"PLUGIN_LOAD_FAILED")});
testWithEnv("plugin-loader: loadInstalledPlugin throws PLUGIN_LOAD_FAILED when no plugin claims the namespace",
async env=>{await seedInstalledPlugin(env.home,"audit",{id:"audit",command:"different.command"});
const{loadInstalledPlugin}=await importFresh(LOADER_MODULE);
const error=await captureRejection(loadInstalledPlugin("audit"));
assert.equal(error.code,"PLUGIN_LOAD_FAILED");
assert.equal(error.details.namespace,"audit")});
testWithEnv("plugin-loader: loadInstalledPlugin loads the dir whose descriptor.command matches the namespace, even when id != command",
async env=>{await seedInstalledPlugin(env.home,"example.audit",{id:"example.audit",command:"audit"});
const{loadInstalledPlugin}=await importFresh(LOADER_MODULE);
const loaded=await loadInstalledPlugin("audit");
assert.equal(loaded.pluginId,"example.audit");
assert.equal(loaded.descriptor.id,"example.audit");
assert.equal(loaded.descriptor.command,"audit");
assert.equal(typeof loaded.commands.ping,"function");
assert.ok(loaded.installedDir.endsWith(path.join("installed","example.audit")))});
testWithEnv("plugin-loader: loadInstalledPlugin throws PLUGIN_INVALID_DESCRIPTOR when descriptor.id != installed dir name",
async env=>{const installedRoot=path.join(env.home,"plugins","installed","mismatch");
await fs.mkdir(installedRoot,{recursive:true});
  await fs.writeFile(path.join(installedRoot,"package.json"),JSON.stringify({name:"mismatch-pkg",version:"1.0.0",
type:"module",climier:{id:"wrong.id",command:"mismatch",entry:"./climier.mjs",api:1}},null,2)+"\n","utf8");
await fs.writeFile(path.join(installedRoot,"climier.mjs"),"export default { commands: { ping: () => ({ ok: true }) } };\n",
"utf8");
const{loadInstalledPlugin}=await importFresh(LOADER_MODULE);
const error=await captureRejection(loadInstalledPlugin("mismatch"));
assert.equal(error.code,"PLUGIN_INVALID_DESCRIPTOR");
assert.equal(error.details.descriptor_id,"wrong.id");
assert.equal(error.details.namespace,"mismatch")});
testWithEnv("plugin-loader: hasInstalledPlugin returns true only when descriptor.command === namespace",async env=>{await seedInstalledPlugin(env.home,
"example.audit",{id:"example.audit",command:"audit"});
const{hasInstalledPlugin}=await importFresh(LOADER_MODULE);
assert.equal(await hasInstalledPlugin("audit"),true);
assert.equal(await hasInstalledPlugin("example.audit"),false);
assert.equal(await hasInstalledPlugin("ghost"),false)});
testWithEnv("plugin-loader: loadInstalledPlugin throws PLUGIN_LOAD_FAILED when default.commands is missing",
async env=>{await seedInstalledPlugin(env.home,"broken",{entryCode:"export default { foo: 1 };\n"});
const{loadInstalledPlugin}=await importFresh(LOADER_MODULE);
const error=await captureRejection(loadInstalledPlugin("broken"));
assert.equal(error.code,"PLUGIN_LOAD_FAILED")});
testWithEnv("plugin-loader: loadInstalledPlugin throws PLUGIN_INVALID_DESCRIPTOR when descriptor field is malformed",
async env=>{const installedRoot=path.join(env.home,"plugins","installed","bad");
await fs.mkdir(installedRoot,{recursive:true});
    await fs.writeFile(path.join(installedRoot,"package.json"),JSON.stringify({name:"bad",type:"module",climier:{id:".bad",
command:"bad",entry:"./x.mjs",api:1}},null,2)+"\n","utf8");
await fs.writeFile(path.join(installedRoot,"climier.mjs"),"export default { commands: {} };\n","utf8");
const{loadInstalledPlugin}=await importFresh(LOADER_MODULE);
const error=await captureRejection(loadInstalledPlugin("bad"));
assert.equal(error.code,"PLUGIN_INVALID_DESCRIPTOR")});
testWithEnv("plugin-dispatch: dispatches to handler and returns its result with forwarded tokens + api.runtime",
async env=>{await seedInstalledPlugin(env.home,"audit");
const{dispatchPlugin}=await importFresh(DISPATCH_MODULE);
let receivedApi;
  const createApi=({projectDir,agent,pluginId})=>{receivedApi={projectDir,agent,pluginId};
return{runtime:{project_dir:projectDir,agent},query:{},data:{}}};
  const result=await dispatchPlugin({originalArgv:["--project",env.projectDir,"--as","alice","audit","ping",
"--foo","bar"],namespace:"audit",projectDir:env.projectDir,flags:{project:env.projectDir,as:"alice"},createApi});
assert.equal(result.ok,true);
assert.equal(result.command,"ping");
assert.deepEqual(result.args,["--project",env.projectDir,"--as","alice","--foo","bar"]);
assert.equal(result.api_runtime.project_dir,env.projectDir);
assert.equal(result.api_runtime.agent,"alice");
assert.deepEqual(receivedApi,{projectDir:env.projectDir,agent:"alice",pluginId:"audit"})});
testWithEnv("plugin-dispatch: missing subcommand throws PLUGIN_SUBCOMMAND_NOT_FOUND with namespace in details",
async env=>{await seedInstalledPlugin(env.home,"audit");
const{dispatchPlugin}=await importFresh(DISPATCH_MODULE);
  const error=await captureRejection(dispatchPlugin({originalArgv:["audit"],namespace:"audit",projectDir:env.projectDir,
flags:{as:"alice"},createApi:({projectDir,agent})=>({runtime:{project_dir:projectDir,agent},query:{},data:{}})}));
assert.equal(error.code,"PLUGIN_SUBCOMMAND_NOT_FOUND");
assert.equal(error.details.namespace,"audit");
assert.equal(error.details.subcommand,null)});
testWithEnv("plugin-dispatch: unknown subcommand throws PLUGIN_SUBCOMMAND_NOT_FOUND",async env=>{await seedInstalledPlugin(env.home,
"audit");
const{dispatchPlugin}=await importFresh(DISPATCH_MODULE);
  const error=await captureRejection(dispatchPlugin({originalArgv:["audit","ghost"],namespace:"audit",projectDir:env.projectDir,
flags:{as:"alice"},createApi:({projectDir,agent})=>({runtime:{project_dir:projectDir,agent},query:{},data:{}})}));
assert.equal(error.code,"PLUGIN_SUBCOMMAND_NOT_FOUND");
assert.equal(error.details.namespace,"audit");
assert.equal(error.details.subcommand,"ghost")});
testWithEnv("plugin-dispatch: handler throwing is mapped to PLUGIN_HANDLER_FAILED with details",async env=>{await seedInstalledPlugin(env.home,
"audit");
const{dispatchPlugin}=await importFresh(DISPATCH_MODULE);
let caught;
    try{await dispatchPlugin({originalArgv:["audit","thrower"],namespace:"audit",projectDir:env.projectDir,flags:{as:"alice"},
createApi:({projectDir,agent})=>({runtime:{project_dir:projectDir,agent},query:{},data:{}})})}catch(err){caught=err}assert.ok(caught,
"expected dispatchPlugin to throw");
assert.equal(caught.code,"PLUGIN_HANDLER_FAILED");
assert.equal(caught.details.plugin_id,"audit");
assert.equal(caught.details.namespace,"audit");
assert.equal(caught.details.subcommand,"thrower");
assert.match(caught.details.cause,/handler-boom/)});
testWithEnv("plugin-dispatch: handler throwing an existing PLUGIN_* error is propagated without rewrapping",
async env=>{await seedInstalledPlugin(env.home,"audit");
const{dispatchPlugin}=await importFresh(DISPATCH_MODULE);
let caught;
    try{await dispatchPlugin({originalArgv:["audit","rethrow"],namespace:"audit",projectDir:env.projectDir,flags:{as:"alice"},
createApi:({projectDir,agent})=>({runtime:{project_dir:projectDir,agent},query:{},data:{}})})}catch(err){caught=err}assert.ok(caught,
"expected dispatchPlugin to throw");
assert.equal(caught.code,"PLUGIN_LOAD_FAILED");
assert.deepEqual(caught.details,{from:"handler"})});
testWithEnv("plugin-dispatch: forwarded tokens preserve original order even when flags appear before the namespace",
async env=>{await seedInstalledPlugin(env.home,"audit");
const{dispatchPlugin}=await importFresh(DISPATCH_MODULE);
  const result=await dispatchPlugin({originalArgv:["--project","/tmp/p","audit","ping","--foo","bar","tail"],
      namespace:"audit",projectDir:"/tmp/p",flags:{project:"/tmp/p",as:"alice"},createApi:({projectDir,agent})=>({runtime:{project_dir:projectDir,
agent},query:{},data:{}})});
assert.deepEqual(result.args,["--project","/tmp/p","--foo","bar","tail"])});
testWithEnv("plugin-dispatch: missing --as throws PLUGIN_HANDLER_FAILED with agent details",async env=>{await seedInstalledPlugin(env.home,
"audit");
const prev=process.env.CLIMIER_AGENT;
delete process.env.CLIMIER_AGENT;
const{dispatchPlugin}=await importFresh(DISPATCH_MODULE);
let caught;
    try{await dispatchPlugin({originalArgv:["audit","ping"],namespace:"audit",projectDir:env.projectDir,flags:{},
createApi:({projectDir,agent})=>({runtime:{project_dir:projectDir,agent},query:{},data:{}})})}catch(err){caught=err}finally{if(prev!==void 0){process.env.CLIMIER_AGENT=prev}}assert.ok(caught,
"expected dispatchPlugin to throw");
assert.equal(caught.code,"PLUGIN_HANDLER_FAILED");
assert.equal(caught.details.namespace,"audit");
assert.match(caught.message,/agent/i)});
testWithEnv("plugin-dispatch: api.runtime uses effective project/agent even if forwarded tokens repeat them",
async env=>{await seedInstalledPlugin(env.home,"audit");
const{dispatchPlugin}=await importFresh(DISPATCH_MODULE);
  const result=await dispatchPlugin({originalArgv:["--project",env.projectDir,"--as","alice","audit","ping",
    "--project","/tmp/elsewhere","--as","mallory"],namespace:"audit",projectDir:env.projectDir,flags:{project:env.projectDir,
as:"alice"},createApi:({projectDir,agent})=>({runtime:{project_dir:projectDir,agent},query:{},data:{}})});
assert.equal(result.api_runtime.project_dir,env.projectDir);
assert.equal(result.api_runtime.agent,"alice");
assert.ok(result.args.includes("/tmp/elsewhere"));
assert.ok(result.args.includes("mallory"))});
testWithEnv("bin: core commands (status, init, --version) keep working without changes",async env=>{const dir=env.projectDir;
let r=await runCli(["--project",dir,"init"]);
assert.equal(r.code,0,r.stderr);
r=await runCli(["--project",dir,"status"]);
assert.equal(r.code,0,r.stderr);
const data=JSON.parse(r.stdout);
assert.ok(data.summary);
r=await runCli(["--project",dir,"--version"]);
assert.equal(r.code,0,r.stderr);
assert.match(r.stdout.trim(),/^\d+\.\d+\.\d+/)});
testWithEnv("bin: unknown command exits 2 with `unknown command '<x>'` JSON",async env=>{const r=await runCli(["--project",
env.projectDir,"nosuchplugin"]);
assert.equal(r.code,2,r.stderr);
const data=JSON.parse(r.stdout);
assert.equal(data.error.code,"CLI_USAGE_ERROR");assert.equal(data.error.details.command,"nosuchplugin")});
testWithEnv("bin: node id passed as `climier show <id>` still works when <id> collides with a plugin namespace",
async env=>{const dir=env.projectDir;
let r=await runCli(["--project",dir,"init"]);
assert.equal(r.code,0,r.stderr);
r=await runCli(["--project",dir,"add-initiative","demo","--desc","demo"]);
assert.equal(r.code,0,r.stderr);
r=await runCli(["--project",dir,"add-task","audit","--initiative","demo","--title","a task whose id is 'audit'",
"--body","b","--acceptance","a","--blocked-by",""]);
assert.equal(r.code,0,r.stderr);
await seedInstalledPlugin(env.home,"audit");
r=await runCli(["--project",dir,"show","audit"]);
assert.equal(r.code,0,r.stderr);
const data=JSON.parse(r.stdout);
assert.equal(data.type,"task");
assert.equal(data.node.id,"audit")});
testWithEnv("bin: installed namespace dispatches to its handler and returns its JSON",async env=>{await seedInstalledPlugin(env.home,
"audit");
const r=await runCli(["--project",env.projectDir,"--as","alice","audit","ping","--foo","bar"]);
assert.equal(r.code,0,r.stderr);
const data=JSON.parse(r.stdout);
assert.equal(data.ok,true);
assert.equal(data.command,"ping");
assert.deepEqual(data.args,["--project",env.projectDir,"--as","alice","--foo","bar"]);
assert.equal(data.api_runtime.project_dir,env.projectDir);
assert.equal(data.api_runtime.agent,"alice")});
testWithEnv("bin: installed namespace without subcommand returns PLUGIN_SUBCOMMAND_NOT_FOUND with exit 1",
async env=>{await seedInstalledPlugin(env.home,"audit");
const r=await runCli(["--project",env.projectDir,"audit"]);
assert.equal(r.code,1,r.stderr);
const data=JSON.parse(r.stdout);
assert.equal(data.ok,false);
assert.equal(data.error.code,"PLUGIN_SUBCOMMAND_NOT_FOUND");
assert.equal(data.error.details.namespace,"audit");
assert.equal(data.error.details.subcommand,null)});
testWithEnv("bin: installed namespace with nonexistent subcommand returns PLUGIN_SUBCOMMAND_NOT_FOUND with exit 1",
async env=>{await seedInstalledPlugin(env.home,"audit");
const r=await runCli(["--project",env.projectDir,"audit","ghost"]);
assert.equal(r.code,1,r.stderr);
const data=JSON.parse(r.stdout);
assert.equal(data.ok,false);
assert.equal(data.error.code,"PLUGIN_SUBCOMMAND_NOT_FOUND");
assert.equal(data.error.details.namespace,"audit");
assert.equal(data.error.details.subcommand,"ghost")});
testWithEnv("bin: unknown namespace preserves exit 2 with `unknown command '<x>'`",async env=>{const r=await runCli(["--project",
env.projectDir,"nosuchplugin","sub"]);
assert.equal(r.code,2,r.stderr);
const data=JSON.parse(r.stdout);
assert.equal(data.error.code,"CLI_USAGE_ERROR");assert.equal(data.error.details.command,"nosuchplugin")});
testWithEnv("bin: handler promise rejection produces PLUGIN_HANDLER_FAILED envelope with exit 1",async env=>{await seedInstalledPlugin(env.home,
"audit");
const r=await runCli(["--project",env.projectDir,"audit","thrower"]);
assert.equal(r.code,1,r.stderr);
const data=JSON.parse(r.stdout);
assert.equal(data.ok,false);
assert.equal(data.error.code,"PLUGIN_HANDLER_FAILED");
assert.equal(data.error.details.plugin_id,"audit");
assert.equal(data.error.details.namespace,"audit");
assert.equal(data.error.details.subcommand,"thrower");
assert.match(data.error.details.cause,/handler-boom/)});
testWithEnv("bin: handler rethrowing an existing PLUGIN_* error preserves its envelope",async env=>{await seedInstalledPlugin(env.home,
"audit");
const r=await runCli(["--project",env.projectDir,"audit","rethrow"]);
assert.equal(r.code,1,r.stderr);
const data=JSON.parse(r.stdout);
assert.equal(data.ok,false);
assert.equal(data.error.code,"PLUGIN_LOAD_FAILED");
assert.deepEqual(data.error.details,{from:"handler"})});
testWithEnv("bin: malformed installed plugin (no default.commands) yields PLUGIN_LOAD_FAILED envelope",async env=>{await seedInstalledPlugin(env.home,
"broken",{entryCode:"export default { foo: 1 };\n"});
const r=await runCli(["--project",env.projectDir,"broken","ping"]);
assert.equal(r.code,1,r.stderr);
const data=JSON.parse(r.stdout);
assert.equal(data.ok,false);
assert.equal(data.error.code,"PLUGIN_LOAD_FAILED")});
testWithEnv("bin: flags placed before the namespace are still forwarded to the handler in original order",
async env=>{await seedInstalledPlugin(env.home,"audit");
const r=await runCli(["--project",env.projectDir,"--as","alice","audit","ping","--foo","bar"]);
assert.equal(r.code,0,r.stderr);
const data=JSON.parse(r.stdout);
assert.deepEqual(data.args,["--project",env.projectDir,"--as","alice","--foo","bar"])});
testWithEnv("bin: dispatches by command (first token), not by descriptor.id, when id != command",async env=>{await seedInstalledPlugin(env.home,
"example.audit",{id:"example.audit",command:"audit"});
const r=await runCli(["--project",env.projectDir,"--as","alice","audit","ping"]);
assert.equal(r.code,0,r.stderr);
const data=JSON.parse(r.stdout);
assert.equal(data.command,"ping");
assert.equal(data.api_runtime.project_dir,env.projectDir);
assert.equal(data.api_runtime.agent,"alice");
const installedPkg=JSON.parse(await fs.readFile(path.join(env.home,"plugins","installed","example.audit","package.json"),
"utf8"));
assert.equal(installedPkg.climier.id,"example.audit");
assert.equal(installedPkg.climier.command,"audit")});
testWithEnv("bin: effective --project/--as live in api.runtime even if forwarded tokens repeat them with different values",
async env=>{await seedInstalledPlugin(env.home,"audit");
const r=await runCli(["--project",env.projectDir,"--as","alice","audit","ping","--project","/tmp/elsewhere",
"--as","mallory"]);
assert.equal(r.code,0,r.stderr);
const data=JSON.parse(r.stdout);
assert.equal(data.api_runtime.project_dir,env.projectDir);
assert.equal(data.api_runtime.agent,"alice");
assert.ok(data.args.includes("/tmp/elsewhere"));
assert.ok(data.args.includes("mallory"))});
testWithEnv("reserved-namespaces: the dispatcher's plugin check shares the single source of truth",async()=>{const{RESERVED_NAMESPACES}=await importFresh(RESERVED_MODULE);
assert.ok(RESERVED_NAMESPACES.includes("install"));
assert.ok(RESERVED_NAMESPACES.includes("uninstall"));
assert.ok(RESERVED_NAMESPACES.includes("status"))});
