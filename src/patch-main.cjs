"use strict";

const crypto = require("node:crypto");
const vm = require("node:vm");

const PATCH_MARKER = "__MIRASIM_WINDOWS_REMOTE_SSH_PATCH_V2__";
const SUPPORTED_PROFILES = new Map([
  ["0.0.170", {
    originalMainSha256: "ad39985ad769ae14dfefe47cbac093b6298cc2d5de1b05053b21a629332ae155",
    patchedMainSha256: "d5bc05829422daaeadbefd1fbaecba69edd1b6a4310f379c6d83bd007c464892",
  }],
  ["0.0.203", {
    originalMainSha256: "81c9293718d40acc269829ff933c1c414babe6dd276330ebd8c7ad89243c47ee",
    patchedMainSha256: "a7fb88553d37377269ed69eb48bc2e7c8d232f76fb69a9374d798196f60575d4",
  }],
  ["0.0.205", {
    originalMainSha256: "ca3914e0e2bf7f56fd663d47adbc618982c4465229fd82d439a02e046abad343",
    patchedMainSha256: "cb489d103383e22f30a6ba8f10fb9030183ccd6a6da469d54b1632dd2a7ce60a",
  }],
]);
const SUPPORTED_VERSIONS = new Set(SUPPORTED_PROFILES.keys());

function sourceSha256(source) {
  return crypto.createHash("sha256").update(source, "utf8").digest("hex");
}

function countOccurrences(source, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function uniqueIndex(source, needle, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`${label}: expected marker was not found`);
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`${label}: marker is not unique`);
  }
  return first;
}

function replaceExactlyOnce(source, label, before, after) {
  if (source.includes(after)) return source;
  const offset = uniqueIndex(source, before, label);
  return source.slice(0, offset) + after + source.slice(offset + before.length);
}

function replaceRegexExactlyOnce(source, label, regex, replacer) {
  const matches = [...source.matchAll(regex)];
  if (matches.length !== 1) {
    throw new Error(`${label}: expected one semantic match, found ${matches.length}`);
  }
  const match = matches[0];
  const replacement = typeof replacer === "function" ? replacer(match) : replacer;
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

function findMatchingBrace(source, openOffset) {
  if (source[openOffset] !== "{") throw new Error("Internal error: expected an opening brace");
  let depth = 0;
  let state = "normal";
  let escaped = false;
  let regexClass = false;
  let previousSignificant = "";
  for (let i = openOffset; i < source.length; i += 1) {
    const character = source[i];
    const next = source[i + 1];
    if (state === "single" || state === "double" || state === "template") {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if ((state === "single" && character === "'") ||
                 (state === "double" && character === '"') ||
                 (state === "template" && character === "`")) {
        state = "normal";
      }
      continue;
    }
    if (state === "line-comment") {
      if (character === "\n" || character === "\r") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "normal";
        i += 1;
      }
      continue;
    }
    if (state === "regex") {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "[") {
        regexClass = true;
      } else if (character === "]") {
        regexClass = false;
      } else if (character === "/" && !regexClass) {
        state = "normal";
      }
      continue;
    }
    if (character === "/" && next === "/") {
      state = "line-comment";
      i += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      state = "block-comment";
      i += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      state = character === "'" ? "single" : character === '"' ? "double" : "template";
      continue;
    }
    if (character === "/" && (!previousSignificant || "([{:;,=!?&|+-*%^~<>".includes(previousSignificant))) {
      state = "regex";
      regexClass = false;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    if (!/\s/.test(character)) previousSignificant = character;
  }
  throw new Error("Could not find the end of a JavaScript block");
}

function containingFunction(source, marker, label) {
  const markerOffset = uniqueIndex(source, marker, label);
  const start = source.lastIndexOf("function ", markerOffset);
  if (start < 0 || markerOffset - start > 2000) throw new Error(`${label}: containing function was not found`);
  const open = source.indexOf("{", start);
  if (open < 0 || open > markerOffset) throw new Error(`${label}: malformed function header`);
  const close = findMatchingBrace(source, open);
  if (close < markerOffset) throw new Error(`${label}: marker is outside the selected function`);
  return { start, open, close, text: source.slice(start, close + 1) };
}

function replaceSegment(source, segment, replacement) {
  return source.slice(0, segment.start) + replacement + source.slice(segment.close + 1);
}

function patchAskpassWrapper(source) {
  if (source.includes("windows-askpass.exe")) return source;
  const segment = containingFunction(source, "'ssh-askpass-wrapper.sh'", "Windows askpass wrapper");
  const header = segment.text.match(/^function\s+([\w$]+)\(([\w$]+),([\w$]+)\)\{/);
  if (!header) throw new Error("Windows askpass wrapper: function shape changed");
  const [, , directoryArgument] = header;
  const fsMatch = segment.text.match(new RegExp("([\\w$]+)\\['default'\\]\\['mkdirSync'\\]\\(" + directoryArgument));
  const pathMatch = segment.text.match(new RegExp("([\\w$]+)\\['default'\\]\\['join'\\]\\(" + directoryArgument + ",'ssh-askpass-wrapper\\.sh'\\)"));
  if (!fsMatch || !pathMatch) throw new Error("Windows askpass wrapper: filesystem aliases were not recognized");
  const pathDeclaration = new RegExp(`;let ([\\w$]+)=${pathMatch[1]}\\['default'\\]\\['join'\\]\\(${directoryArgument},'ssh-askpass-wrapper\\.sh'\\)`);
  const declarations = [...segment.text.matchAll(new RegExp(pathDeclaration.source, "g"))];
  if (declarations.length !== 1) throw new Error(`Windows askpass wrapper: expected one path declaration, found ${declarations.length}`);
  const declaration = declarations[0];
  const winCode = `;if(process['platform']==='win32'){let __mirasimAskpassPath=${pathMatch[1]}['default']['join'](process['resourcesPath'],'mirasim-ssh-fix','windows-askpass.exe');if(!${fsMatch[1]}['default']['existsSync'](__mirasimAskpassPath))throw new Error('Mirasim Windows askpass helper is missing. Run mirasim-ssh-fix repair.');return __mirasimAskpassPath;}let ${declaration[1]}=${pathMatch[1]}['default']['join'](${directoryArgument},'ssh-askpass-wrapper.sh')`;
  const patched = segment.text.slice(0, declaration.index) + winCode + segment.text.slice(declaration.index + declaration[0].length);
  return replaceSegment(source, segment, patched);
}

function patchProbeAskpass(source) {
  if (source.includes("__mirasimProbeAskpassPath")) return source;
  const segment = containingFunction(source, "'mirasim-ssh-'", "Windows probe askpass");
  const directoryMatch = segment.text.match(/let\s+([\w$]+)=([\w$]+)\['default'\]\['mkdtempSync'\]/);
  if (!directoryMatch) throw new Error("Windows probe askpass: temporary directory was not recognized");
  const [, directoryVariable, fsAlias] = directoryMatch;
  const pathRegex = new RegExp(`let ([\\w$]+)=([\\w$]+)\\['default'\\]\\['join'\\]\\(${directoryVariable},'askpass\\.sh'\\)`);
  const pathMatches = [...segment.text.matchAll(new RegExp(pathRegex.source, "g"))];
  if (pathMatches.length !== 1) throw new Error(`Windows probe askpass: expected one helper path, found ${pathMatches.length}`);
  const helperPath = pathMatches[0];
  const envKeyMatch = segment.text.match(/\$\{('\+)?([\w$]+)\+'-\}/);
  if (!envKeyMatch) throw new Error("Windows probe askpass: password environment key was not recognized");
  const envKey = envKeyMatch[2];
  const winCode = `if(process['platform']==='win32'){let __mirasimProbeAskpassPath=${helperPath[2]}['default']['join'](${directoryVariable},'askpass.cmd'),__mirasimProbeAskpassBody='@echo off\\r\\nset "ELECTRON_RUN_AS_NODE=1"\\r\\n"'+process['execPath']+'" -e "process.stdout.write(process.env.'+${envKey}+'||\\'\\')"\\r\\n';return ${fsAlias}['default']['writeFileSync'](__mirasimProbeAskpassPath,__mirasimProbeAskpassBody),{'file':__mirasimProbeAskpassPath,'dir':${directoryVariable}};}`;
  const insertion = helperPath.index;
  const patched = segment.text.slice(0, insertion) + winCode + segment.text.slice(insertion);
  return replaceSegment(source, segment, patched);
}

function patchSshAddAskpass(source) {
  if (source.includes("__mirasimSshAddAskpassPath")) return source;
  const segment = containingFunction(source, "'ssh-add-askpass.sh'", "Windows ssh-add askpass");
  const header = segment.text.match(/^function\s+[\w$]+\(([\w$]+)\)\{/);
  const pathMatch = segment.text.match(/([\w$]+)\['default'\]\['join'\]\(([\w$]+),'ssh-add-askpass\.sh'\)/);
  const fsMatch = segment.text.match(/([\w$]+)\['default'\]\['mkdirSync'\]/);
  if (!header || !pathMatch || !fsMatch || header[1] !== pathMatch[2]) {
    throw new Error("Windows ssh-add askpass: function shape changed");
  }
  const argument = header[1];
  const winCode = `if(process['platform']==='win32'){let __mirasimSshAddAskpassPath=${pathMatch[1]}['default']['join'](${argument},'ssh-add-askpass.cmd'),__mirasimSshAddAskpassBody='@echo off\\r\\nset "ELECTRON_RUN_AS_NODE=1"\\r\\n"'+process['execPath']+'" -e "process.stdout.write((process.env.MIRASIM_ASKPASS_ANSWER||\\'\\')+\\'\\\\n\\')"\\r\\n';return ${fsMatch[1]}['default']['mkdirSync'](${argument},{'recursive':true}),${fsMatch[1]}['default']['writeFileSync'](__mirasimSshAddAskpassPath,__mirasimSshAddAskpassBody),__mirasimSshAddAskpassPath;}`;
  const insertion = segment.text.indexOf("{") + 1;
  const patched = segment.text.slice(0, insertion) + winCode + segment.text.slice(insertion);
  return replaceSegment(source, segment, patched);
}

function patchAskpassServer(source) {
  if (source.includes("__mirasimWindowsAskpassServer")) return source;
  const regex = /function\s+([\w$]+)\(([\w$]+)\)\{let\s+\{socketPath:([\w$]+),onRequest:([\w$]+),log:([\w$]+)\}=\2,([\w$]+)=([\w$]+)\['default'\]\['dirname'\]\(\3\);/g;
  const matches = [...source.matchAll(regex)];
  if (matches.length !== 1) throw new Error(`Windows askpass server: expected one semantic match, found ${matches.length}`);
  const match = matches[0];
  const open = source.indexOf("{", match.index);
  const close = findMatchingBrace(source, open);
  const segment = { start: match.index, open, close, text: source.slice(match.index, close + 1) };
  const headerLength = match[0].length;
  const asyncOffset = segment.text.indexOf("async function", headerLength);
  if (asyncOffset < 0) throw new Error("Windows askpass server: inner request handler was not found");
  const operationsEnd = segment.text.lastIndexOf(";", asyncOffset);
  const operations = segment.text.slice(headerLength, operationsEnd);
  if (!operations.includes("['mkdirSync']") || !operations.includes("['rmSync']") || operations.includes(";")) {
    throw new Error("Windows askpass server: startup filesystem operations changed");
  }
  const fsMatch = operations.match(/([\w$]+)\['default'\]\['mkdirSync'\]/);
  if (!fsMatch) throw new Error("Windows askpass server: filesystem alias missing");
  let patched = segment.text.slice(0, headerLength) +
    `let __mirasimWindowsAskpassServer=true;process['platform']!=='win32'&&(${operations})` +
    segment.text.slice(operationsEnd);
  const chmodNeedle = `${fsMatch[1]}['default']['chmodSync'](${match[3]},`;
  if (countOccurrences(patched, chmodNeedle) !== 1) {
    throw new Error("Windows askpass server: socket chmod call changed");
  }
  patched = patched.replace(chmodNeedle, `process['platform']!=='win32'&&${chmodNeedle}`);
  return replaceSegment(source, segment, patched);
}

function patchSshProcessClass(source) {
  if (source.includes("__mirasimTunnelChild")) return source;
  const masterMarker = "['-M','-N','-oControlPath='+this['controlPath']";
  const masterOffset = uniqueIndex(source, masterMarker, "Windows SSH process class");
  const startOffset = source.lastIndexOf("['start'](){", masterOffset);
  if (startOffset < 0 || masterOffset - startOffset > 1000) throw new Error("Windows SSH process class: start method was not found");
  const startOpen = source.indexOf("{", startOffset);
  const startClose = findMatchingBrace(source, startOpen);
  const startText = source.slice(startOffset, startClose + 1);
  const parserMatch = startText.match(/let\s+\{host:[\w$]+,port:[\w$]+\}=([\w$]+)\(this\['target'\]\)/);
  if (!parserMatch) throw new Error("Windows SSH process class: target parser was not recognized");
  const targetParser = parserMatch[1];
  source = source.slice(0, startOpen + 1) + "if(process['platform']==='win32')return Promise.resolve();" + source.slice(startOpen + 1);

  const execOffset = source.indexOf("['exec'](", startOffset);
  if (execOffset < 0 || execOffset <= startClose || execOffset - startClose > 3000) {
    throw new Error("Windows SSH process class: exec method was not found in the expected class region");
  }
  const execOpen = source.indexOf("{", execOffset);
  const execClose = findMatchingBrace(source, execOpen);
  const execHeader = source.slice(execOffset, execOpen + 1);
  const execParameterMatch = execHeader.match(/\['exec'\]\(([\w$]+)\)\{/);
  if (!execParameterMatch) throw new Error("Windows SSH process class: exec method changed");
  const execParameter = execParameterMatch[1];
  const execWin = `if(process['platform']==='win32'){let {host:__mirasimExecHost,port:__mirasimExecPort}=${targetParser}(this['target']);return this['runOnce'](this['sshBin'],['-oClearAllForwardings=yes',...this['extraArgs'],...__mirasimExecPort!==null?['-p',String(__mirasimExecPort)]:[],__mirasimExecHost,${execParameter}])['then'](__mirasimExecResult=>(this['masterStderr']+=__mirasimExecResult['stderr']||'',__mirasimExecResult));}`;
  source = source.slice(0, execOpen + 1) + execWin + source.slice(execOpen + 1);

  const forwardOffset = source.indexOf("async['forward'](", execOffset);
  if (forwardOffset < 0 || forwardOffset <= execClose || forwardOffset - execClose > 3000) {
    throw new Error("Windows SSH process class: forward method was not found in the expected class region");
  }
  const forwardOpen = source.indexOf("{", forwardOffset);
  const forwardClose = findMatchingBrace(source, forwardOpen);
  const forwardHeader = source.slice(forwardOffset, forwardOpen + 1);
  const forwardParameters = forwardHeader.match(/async\['forward'\]\(([\w$]+),([\w$]+)\)\{/);
  if (!forwardParameters) throw new Error("Windows SSH process class: forward method changed");
  const localPort = forwardParameters[1];
  const remoteSocket = forwardParameters[2];
  const forwardWin = `if(process['platform']==='win32'){let {host:__mirasimTunnelHost,port:__mirasimTunnelPort}=${targetParser}(this['target']),__mirasimTunnelArgs=['-N','-oClearAllForwardings=no','-oExitOnForwardFailure=yes','-oServerAliveInterval=15','-oServerAliveCountMax=3',...this['extraArgs'],'-L','127.0.0.1:'+${localPort}+':'+${remoteSocket},...__mirasimTunnelPort!==null?['-p',String(__mirasimTunnelPort)]:[],__mirasimTunnelHost],__mirasimTunnelChild=require('node:child_process')['spawn'](this['sshBin'],__mirasimTunnelArgs,{'env':this['env'],'stdio':['ignore','ignore','pipe']});this['master']=__mirasimTunnelChild,this['exited']=false,this['lastExit']=null,this['masterStderr']='';__mirasimTunnelChild['stderr']?.['on']('data',__mirasimTunnelData=>{let __mirasimTunnelText=__mirasimTunnelData['toString']('utf8');this['masterStderr']+=__mirasimTunnelText,this['log']?.(__mirasimTunnelText['trimEnd']());});await new Promise((__mirasimTunnelResolve,__mirasimTunnelReject)=>{let __mirasimTunnelSettled=false,__mirasimTunnelStarted=Date['now'](),__mirasimTunnelFail=__mirasimTunnelError=>{if(__mirasimTunnelSettled)return;__mirasimTunnelSettled=true,__mirasimTunnelReject(__mirasimTunnelError);},__mirasimTunnelClosed=__mirasimTunnelCode=>{this['exited']=true,this['lastExit']={'code':__mirasimTunnelCode};for(let __mirasimTunnelCallback of this['exitCallbacks']['slice']())__mirasimTunnelCallback({'code':__mirasimTunnelCode});__mirasimTunnelFail(new Error('ssh tunnel exited before becoming ready (code '+__mirasimTunnelCode+')'+this['exitDetail']()));};__mirasimTunnelChild['on']('close',__mirasimTunnelClosed),__mirasimTunnelChild['on']('error',__mirasimTunnelFail);let __mirasimTunnelProbe=()=>{if(__mirasimTunnelSettled)return;let __mirasimTunnelSocket=require('node:net')['connect']({'host':'127.0.0.1','port':${localPort}}),__mirasimTunnelProbeDone=false,__mirasimTunnelFinish=__mirasimTunnelReady=>{if(__mirasimTunnelProbeDone)return;__mirasimTunnelProbeDone=true,__mirasimTunnelSocket['destroy']();if(__mirasimTunnelSettled)return;if(__mirasimTunnelReady){__mirasimTunnelSettled=true,__mirasimTunnelResolve();return;}if(Date['now']()-__mirasimTunnelStarted>=this['checkTimeoutMs']){__mirasimTunnelSettled=true,this['exited']||__mirasimTunnelChild['kill']('SIGKILL'),__mirasimTunnelReject(new Error('ssh tunnel timed out after '+this['checkTimeoutMs']+'ms: '+this['masterStderr']['trim']()));return;}setTimeout(__mirasimTunnelProbe,this['checkIntervalMs']);};__mirasimTunnelSocket['once']('connect',()=>__mirasimTunnelFinish(true)),__mirasimTunnelSocket['once']('error',()=>__mirasimTunnelFinish(false)),__mirasimTunnelSocket['setTimeout'](Math['min'](this['checkIntervalMs'],1000),()=>__mirasimTunnelFinish(false));};setTimeout(__mirasimTunnelProbe,this['checkIntervalMs']);});return;}`;
  source = source.slice(0, forwardOpen + 1) + forwardWin + source.slice(forwardOpen + 1);

  const scpOffset = source.indexOf("async['scpTo'](", forwardOffset);
  if (scpOffset < 0 || scpOffset <= forwardClose || scpOffset - forwardClose > 3000) {
    throw new Error("Windows SSH process class: scp method was not found in the expected class region");
  }
  const scpOpen = source.indexOf("{", scpOffset);
  const scpClose = findMatchingBrace(source, scpOpen);
  const scpText = source.slice(scpOffset, scpClose + 1);
  const scpNeedle = "['-oControlPath='+this['controlPath'],...this['extraArgs']";
  if (countOccurrences(scpText, scpNeedle) !== 1) throw new Error("Windows SSH process class: scp arguments changed");
  const scpPatched = scpText.replace(scpNeedle, "[...process['platform']==='win32'?['-oClearAllForwardings=yes']:['-oControlPath='+this['controlPath']],...this['extraArgs']");
  source = source.slice(0, scpOffset) + scpPatched + source.slice(scpClose + 1);

  const stopOffset = source.indexOf("async['stop'](){", scpOffset);
  if (stopOffset < 0 || stopOffset - scpOffset > 2000) throw new Error("Windows SSH process class: stop method was not found");
  const stopOpen = source.indexOf("{", stopOffset);
  const stopClose = findMatchingBrace(source, stopOpen);
  const stopWin = "if(process['platform']==='win32'){let __mirasimTunnelMaster=this['master'];__mirasimTunnelMaster&&!this['exited']&&__mirasimTunnelMaster['kill']('SIGTERM'),await this['waitForMasterExit']();return;}";
  source = source.slice(0, stopOpen + 1) + stopWin + source.slice(stopOpen + 1);
  return source;
}

const LEGACY_RUNTIME_HELPER = String.raw`
const __MIRASIM_WINDOWS_REMOTE_SSH_PATCH_V2__='0.1.0';
async function __mirasimEnsureLegacyLinuxRuntime(__mirasimMaster){
  if(process['platform']!=='win32')return false;
  let __mirasimNodeCheck=await __mirasimMaster['exec']("sh -c '~/.mirasim-remote/current/node --version >/dev/null 2>&1'");
  if(__mirasimNodeCheck['code']===0)return false;
  let __mirasimProbe=await __mirasimMaster['exec']("sh -c 'uname -s; uname -m; getconf GNU_LIBC_VERSION 2>/dev/null || true'"),
      __mirasimLines=(__mirasimProbe['stdout']||'')['replace'](/\r\n/g,'\n')['trim']()['split']('\n'),
      __mirasimGlibc=/glibc\s+(\d+)\.(\d+)/i['exec'](__mirasimLines[2]||'');
  if((__mirasimLines[0]||'')['trim']()!=='Linux'||(__mirasimLines[1]||'')['trim']()!=='x86_64'||!__mirasimGlibc)return false;
  let __mirasimMajor=Number(__mirasimGlibc[1]),__mirasimMinor=Number(__mirasimGlibc[2]);
  if(__mirasimMajor!==2||__mirasimMinor>=28)return false;
  if(__mirasimMinor<17)throw new Error('legacy Linux runtime requires glibc 2.17 or newer; detected glibc '+__mirasimMajor+'.'+__mirasimMinor);
  let __mirasimPath=require('node:path'),__mirasimFs=require('node:fs'),__mirasimCrypto=require('node:crypto'),
      __mirasimAssets=__mirasimPath['join'](process['resourcesPath'],'mirasim-ssh-fix','linux-compat'),
      __mirasimFiles=['node-v22.23.1-linux-x64-glibc-217.tar.xz','pty-node-v127-glibc217.node','install-legacy-runtime.sh'],
      __mirasimExpected={'node-v22.23.1-linux-x64-glibc-217.tar.xz':'2e729bf3198098a221681d3f1926a2d505c020a683d3b8e4826e3794818da340','pty-node-v127-glibc217.node':'300bbe67b3b5e4cd30624b2a1671bb26c5a848067810ba5dfca4e1a37e3890c9','install-legacy-runtime.sh':'f5d555d19c67b7e8c3a27c390417c8f562a0dafc69bd41bda6cfef4cfb057bdc'};
  for(let __mirasimFile of __mirasimFiles){let __mirasimLocal=__mirasimPath['join'](__mirasimAssets,__mirasimFile);if(!__mirasimFs['existsSync'](__mirasimLocal))throw new Error('missing packaged legacy Linux runtime asset: '+__mirasimLocal);let __mirasimActual=__mirasimCrypto['createHash']('sha256')['update'](__mirasimFs['readFileSync'](__mirasimLocal))['digest']('hex');if(__mirasimActual!==__mirasimExpected[__mirasimFile])throw new Error('packaged legacy Linux runtime asset failed SHA-256: '+__mirasimFile);}
  let __mirasimPrepare=await __mirasimMaster['exec']('mkdir -p ~/.mirasim-remote/tmp && chmod 700 ~/.mirasim-remote/tmp');
  if(__mirasimPrepare['code']!==0)throw new Error('failed to prepare the legacy Linux runtime directory: '+(__mirasimPrepare['stderr']||__mirasimPrepare['stdout']||'')['trim']());
  for(let __mirasimFile of __mirasimFiles)await __mirasimMaster['scpTo'](__mirasimPath['join'](__mirasimAssets,__mirasimFile),'~/.mirasim-remote/tmp/'+__mirasimFile);
  let __mirasimInstall=await __mirasimMaster['exec']('sh ~/.mirasim-remote/tmp/install-legacy-runtime.sh');
  if(__mirasimInstall['code']!==0)throw new Error('legacy Linux runtime install failed (exit '+__mirasimInstall['code']+'): '+(__mirasimInstall['stderr']||__mirasimInstall['stdout']||'')['trim']());
  return true;
}
`;

function patchLegacyRuntime(source) {
  if (!source.includes(PATCH_MARKER)) {
    const directive = "'use\\x20strict';";
    const offset = source.indexOf(directive);
    if (offset < 0 || offset > 100) throw new Error("Legacy Linux runtime: main bundle directive changed");
    source = source.slice(0, offset + directive.length) + LEGACY_RUNTIME_HELPER + source.slice(offset + directive.length);
  }
  if (source.includes("__mirasimLegacyInstalled")) return source;
  const launching = /this\['setStatus'\]\(([\w$]+),([\w$]+),\{'phase':'connecting','step':'launching'\}\);let /g;
  const matches = [...source.matchAll(launching)];
  if (matches.length !== 1) throw new Error(`Legacy Linux runtime: expected one launch transition, found ${matches.length}`);
  const match = matches[0];
  const lookAhead = source.slice(match.index + match[0].length, match.index + match[0].length + 1200);
  const masterMatch = lookAhead.match(/=await\s+[\w$]+\(([\w$]+),/);
  if (!masterMatch) throw new Error("Legacy Linux runtime: SSH master variable was not recognized");
  const replacement = match[0].slice(0, -4) +
    `let __mirasimLegacyInstalled=await __mirasimEnsureLegacyLinuxRuntime(${masterMatch[1]});__mirasimLegacyInstalled&&this['opts']['log']?.('[remote-ssh] '+${match[1]}+': installed the glibc compatibility runtime');let `;
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

function verifyPatchedSource(source) {
  const required = [
    PATCH_MARKER,
    "windows-askpass.exe",
    "__mirasimProbeAskpassPath",
    "__mirasimSshAddAskpassPath",
    "__mirasimWindowsAskpassServer",
    "__mirasimTunnelChild",
    "__mirasimLegacyInstalled",
    "['-oClearAllForwardings=yes']",
    "-oExitOnForwardFailure=yes",
    "__mirasimMinor<17",
  ];
  for (const marker of required) {
    if (!source.includes(marker)) throw new Error(`Patched source verification failed: ${marker} is missing`);
  }
  if (source.includes("throw new Error('Remote\\x20SSH\\x20workspaces\\x20are\\x20not\\x20supported\\x20on\\x20Windows\\x20yet.')")) {
    throw new Error("Patched source verification failed: Windows platform guard remains");
  }
  new vm.Script(source, { filename: "dist/main.cjs" });
}

function patchMainSource(originalSource, version) {
  const profile = SUPPORTED_PROFILES.get(version);
  if (!profile) {
    throw new Error(`Mirasim ${version} is not supported by this patcher`);
  }
  const inputHash = sourceSha256(originalSource);
  if (originalSource.includes(PATCH_MARKER)) {
    verifyPatchedSource(originalSource);
    if (inputHash !== profile.patchedMainSha256) {
      throw new Error(`Mirasim ${version} has an unrecognized patched main.cjs (${inputHash}). Refusing to overwrite third-party changes.`);
    }
    return { source: originalSource, alreadyPatched: true };
  }
  if (inputHash !== profile.originalMainSha256) {
    throw new Error(`Mirasim ${version} main.cjs is not the verified upstream bundle (${inputHash}). Update this patcher instead of forcing it.`);
  }
  let source = originalSource;
  source = replaceExactlyOnce(
    source,
    "Windows platform guard",
    "['assertPlatformSupported'](){if(process['platform']==='win32')throw new Error('Remote\\x20SSH\\x20workspaces\\x20are\\x20not\\x20supported\\x20on\\x20Windows\\x20yet.');}",
    "['assertPlatformSupported'](){}",
  );
  source = replaceRegexExactlyOnce(
    source,
    "Windows askpass named pipe",
    /return ([A-Za-z_$][\w$]*)\['default'\]\['join'\]\(([A-Za-z_$][\w$]*),'a-'\+([A-Za-z_$][\w$]*)\+'\.sock'\);/g,
    (match) => `return process['platform']==='win32'?'\\\\\\\\.\\\\pipe\\\\mirasim-askpass-'+${match[3]}:${match[0].slice("return ".length)}`,
  );
  source = patchAskpassWrapper(source);
  source = patchProbeAskpass(source);
  source = patchSshAddAskpass(source);
  source = patchAskpassServer(source);
  source = patchSshProcessClass(source);
  source = patchLegacyRuntime(source);
  verifyPatchedSource(source);
  if (sourceSha256(source) !== profile.patchedMainSha256) {
    throw new Error(`Mirasim ${version} produced an unexpected patched main.cjs. No files were changed.`);
  }
  return { source, alreadyPatched: false };
}

module.exports = {
  PATCH_MARKER,
  SUPPORTED_PROFILES,
  SUPPORTED_VERSIONS,
  patchMainSource,
  verifyPatchedSource,
};
