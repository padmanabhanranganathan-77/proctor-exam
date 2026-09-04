/*
 * PROCTOR EXAM v5.7 - DYNAMIC BOOTSTRAP CONFIG
 *
 * Actual exam backend URL is loaded at runtime from the bootstrap service.
 */
const BOOTSTRAP_WEB_APP_URL =
  'https://script.google.com/macros/s/AKfycbyoL1hfJxf3vPhe6nMKnNH0Xc7aYR8do-TkT5dvDxuePAWnk-C9hFb9uWYsM4EcN5TH/exec';

let APPS_SCRIPT_WEB_APP_URL = '';
let bootstrapConfig = null;

let rpcCounter = 0;

let publicConfig = null;
let session = null;
let questions = [];
let answers = {};
let currentQuestion = 0;
let mediaStream = null;
let examActive = false;
let violationCount = 0;
let endTimeMs = 0;
let timerHandle = null;
let autosaveHandle = null;

let awayStartedAt = null;
let awayReason = null;
let awayTimeoutHandle = null;
let lastAwayCloseAt = 0;
let cameraViolationOpen = false;
let fullscreenViolationOpen = false;
let submissionInProgress = false;
let pendingSavePromises = new Set();
let answersDirty = false;
let answerMutationVersion = 0;

/* ==================== DIRECT RPC / JSONP ==================== */

window.addEventListener('load', async function(){
  try{
    bootstrapConfig = await loadBootstrapConfig_();
    APPS_SCRIPT_WEB_APP_URL = String(bootstrapConfig.examApiUrl || '').trim();

    if(!APPS_SCRIPT_WEB_APP_URL){
      throw new Error('Examination service URL was not provided by the configuration service.');
    }

    if(bootstrapConfig.maintenanceMode){
      showFatal('The assessment is temporarily unavailable. Please contact the administrator.');
      return;
    }

    publicConfig = await rpc('getPublicConfig', {});
    publicConfig.maxViolations =
      Number(bootstrapConfig.maxViolations || publicConfig.maxViolations || 3);
    publicConfig.awayTimeoutSeconds =
      Number(bootstrapConfig.awayTimeoutSeconds || 30);

    document.getElementById('appTitle').textContent =
      publicConfig.appTitle || 'Proctored Interview Assessment';

    showView('loginView');
  }catch(err){
    showFatal('Unable to connect to examination server. ' + (err.message || ''));
  }
});

function loadBootstrapConfig_(){
  return new Promise((resolve,reject)=>{
    const callbackName='__proctorBootstrap_'+Date.now()+'_'+Math.floor(Math.random()*1000000);
    const script=document.createElement('script');
    let completed=false;

    const cleanup=()=>{
      try{ delete window[callbackName]; }catch(e){ window[callbackName]=undefined; }
      if(script.parentNode) script.parentNode.removeChild(script);
    };

    const timeout=setTimeout(()=>{
      if(completed) return;
      completed=true; cleanup();
      reject(new Error('Configuration service timed out.'));
    },45000);

    window[callbackName]=function(data){
      if(completed) return;
      completed=true; clearTimeout(timeout); cleanup();
      if(data && data.ok && data.config) resolve(data.config);
      else reject(new Error((data && data.error)||'Unable to load examination configuration.'));
    };

    script.onerror=function(){
      if(completed) return;
      completed=true; clearTimeout(timeout); cleanup();
      reject(new Error('Unable to reach configuration service.'));
    };

    const params=new URLSearchParams();
    params.set('callback',callbackName);
    params.set('_',String(Date.now()));
    script.async=true;
    script.src=BOOTSTRAP_WEB_APP_URL+'?'+params.toString();
    document.head.appendChild(script);
  });
}

function rpc(action, payload, timeoutMs){
  return new Promise((resolve, reject)=>{
    const id =
      'rpc_' +
      Date.now() +
      '_' +
      (++rpcCounter);

    const callbackName =
      '__proctorRpcCallback_' +
      Date.now() +
      '_' +
      rpcCounter;

    const script =
      document.createElement('script');

    let completed = false;

    const cleanup = ()=>{
      try{
        delete window[callbackName];
      }catch(e){
        window[callbackName] = undefined;
      }

      if(script.parentNode){
        script.parentNode.removeChild(script);
      }
    };

    const timeout =
      setTimeout(()=>{
        if(completed){
          return;
        }

        completed = true;
        cleanup();

        reject(
          new Error(
            'Server request timed out.'
          )
        );
      }, Math.max(5000, Number(timeoutMs || 30000)));

    window[callbackName] = function(data){
      if(completed){
        return;
      }

      completed = true;
      clearTimeout(timeout);
      cleanup();

      if(data && data.ok){
        resolve(data.result);
      }else{
        reject(
          new Error(
            (data && data.error) ||
            'Backend error'
          )
        );
      }
    };

    const params =
      new URLSearchParams();

    params.set('callback', callbackName);
    params.set('id', id);
    params.set('action', action);
    params.set('payload', JSON.stringify(payload || {}));
    params.set('_', String(Date.now()));

    script.async = true;

    script.onerror = function(){
      if(completed){
        return;
      }

      completed = true;
      clearTimeout(timeout);
      cleanup();

      reject(
        new Error(
          'Unable to load response from examination server.'
        )
      );
    };

    script.src =
      APPS_SCRIPT_WEB_APP_URL +
      '?' +
      params.toString();

    document.head.appendChild(script);
  });
}


function showBusy(title, message){
  const overlay = document.getElementById('busyOverlay');
  if(!overlay) return;
  const h = overlay.querySelector('[data-busy-title]');
  const p = overlay.querySelector('[data-busy-message]');
  if(h) h.textContent = title || 'Please wait…';
  if(p) p.textContent = message || 'Processing your request.';
  overlay.classList.remove('hidden');
}
function hideBusy(){
  const overlay = document.getElementById('busyOverlay');
  if(overlay) overlay.classList.add('hidden');
}

/* ==================== CAMERA ==================== */

async function enableCamera(){
  const status =
    document.getElementById('cameraStatus');

  const loginFields =
    document.getElementById('loginFields');

  if(
    !navigator.mediaDevices ||
    !navigator.mediaDevices.getUserMedia
  ){
    status.className = 'status bad';

    status.innerHTML =
      '🔴 Camera API unavailable. Please use current Chrome or Edge.';

    return;
  }

  try{
    if(mediaStream){
      mediaStream
        .getTracks()
        .forEach(t=>t.stop());

      mediaStream = null;
    }

    status.className =
      'status checking';

    status.innerHTML =
      '🟡 Requesting camera access… Please click <b>Allow</b>.';

    mediaStream =
      await navigator.mediaDevices.getUserMedia({
        video:{
          width:{ideal:640},
          height:{ideal:480}
        },
        audio:false
      });

    const video =
      document.getElementById('cameraVideo');

    video.srcObject =
      mediaStream;

    await video.play().catch(()=>{});

    if(!cameraActive()){
      throw new Error(
        'Camera stream did not become active.'
      );
    }

    document
      .getElementById('cameraPanel')
      .classList.remove('hidden');

    status.className =
      'status good';

    status.innerHTML =
      '🟢 <b>CAMERA ACTIVE</b> — Monitoring ready.';

    loginFields
      .classList
      .remove('hidden');

    mediaStream
      .getVideoTracks()
      .forEach(track=>{
        track.addEventListener(
          'ended',
          onCameraLost
        );
      });

  }catch(err){
    loginFields
      .classList
      .add('hidden');

    status.className =
      'status bad';

    if(
      err &&
      err.name === 'NotAllowedError'
    ){
      status.innerHTML =
        '🔴 <b>CAMERA ACCESS BLOCKED</b><br>' +
        'Click site controls beside the address bar → Camera → Allow → retry.';

    }else if(
      err &&
      err.name === 'NotFoundError'
    ){
      status.innerHTML =
        '🔴 No webcam detected. Connect or enable a camera and retry.';

    }else if(
      err &&
      err.name === 'NotReadableError'
    ){
      status.innerHTML =
        '🔴 Camera is busy. Close Zoom/Teams/Meet or another camera application and retry.';

    }else{
      status.textContent =
        '🔴 Camera could not start: ' +
        (
          err.message ||
          err.name ||
          'Unknown error'
        );
    }
  }
}

function cameraActive(){
  return (
    !!mediaStream &&
    mediaStream
      .getVideoTracks()
      .some(
        t =>
          t.readyState === 'live' &&
          t.enabled
      )
  );
}

function onCameraLost(){
  if(
    !examActive ||
    cameraViolationOpen
  ){
    return;
  }

  cameraViolationOpen = true;

  registerViolation(
    'CAMERA_OFF',
    'Camera stream stopped.'
  );
}

/* ==================== LOGIN / EXAM ==================== */

async function loginCandidate(){
  setText('loginMsg','');

  if(!cameraActive()){
    setText(
      'loginMsg',
      'Camera must be active before candidate verification.'
    );
    return;
  }

  showBusy('Verifying Candidate…', 'Please wait while your Candidate ID and PIN are verified.');

  try{
    session = await rpc(
      'loginCandidate',
      {
        candidateId:
          document
            .getElementById('candidateId')
            .value
            .trim(),

        pin:
          document
            .getElementById('pin')
            .value
            .trim(),

        userAgent:
          navigator.userAgent
      }
    );

    document
      .getElementById('readyCandidate')
      .textContent =
        session.candidateName +
        ' (' +
        session.candidateId +
        ')';

    document
      .getElementById('candidateDisplay')
      .textContent =
        session.candidateName;

    hideBusy();
    showView('readyView');

  }catch(err){
    hideBusy();
    setText(
      'loginMsg',
      err.message
    );
  }
}

async function beginExam(){
  if(!session){
    return;
  }

  if(!cameraActive()){
    setText(
      'readyMsg',
      'Camera is not active.'
    );
    return;
  }

  try{
    await document
      .documentElement
      .requestFullscreen();

  }catch(err){
    hideBusy();
    setText(
      'readyMsg',
      'Fullscreen permission is required. Please click Start Exam again.'
    );
    return;
  }

  showBusy('Starting Assessment…', 'Please wait while your questions and timer are prepared.');

  try{
    const result =
      await rpc(
        'startExam',
        {
          sessionId:
            session.sessionId,

          clientState:
            clientState()
        }
      );

    questions =
      result.questions || [];

    if(!questions.length){
      setText(
        'readyMsg',
        'No active questions configured.'
      );
      return;
    }

    answers = {};
    currentQuestion = 0;
    violationCount = 0;
    examActive = true;

    endTimeMs =
      new Date(
        result.serverEndTime
      ).getTime();

    document
      .getElementById('qTotal')
      .textContent =
        questions.length;

    document
      .getElementById('violationCount')
      .textContent =
        '0';

    hideBusy();
    showView('examView');

    renderQuestion();
    startTimer();
    startAutosave();

  }catch(err){
    setText(
      'readyMsg',
      err.message
    );
  }
}

/* ==================== QUESTIONS ==================== */

function renderQuestion(){
  const q = questions[currentQuestion];
  if(!q) return;

  document.getElementById('qNum').textContent = currentQuestion + 1;

  const partText = q.part ? ('Part ' + q.part + ' · ') : '';
  const displayNo = q.questionNo || (currentQuestion + 1);
  document.getElementById('questionLabel').textContent =
    partText + 'Question ' + displayNo + ' of ' + questions.length;

  renderQuestionResource(q.resource || null);

  document.getElementById('questionText').textContent = q.question || '';

  const options = document.getElementById('options');
  options.innerHTML = '';

  (q.options || []).forEach(o=>{
    const label = document.createElement('label');
    label.className = 'option';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'answer';
    radio.value = o.key;
    radio.checked = answers[q.id] === o.key;

    radio.addEventListener('change', ()=>{
      answers[q.id] = o.key;
      answersDirty = true;
      answerMutationVersion++;
      renderQuestionNav();

      const savePromise = rpcWithRetry_(
        'saveAnswer',
        {
          sessionId: session.sessionId,
          questionId: q.id,
          answer: o.key
        },
        {timeoutMs:15000, retries:2, baseDelay:450, maxDelay:2500}
      );

      trackSavePromise_(savePromise).catch(()=>{});
    });

    const text = document.createElement('span');
    text.textContent = o.key + '. ' + o.text;
    label.appendChild(radio);
    label.appendChild(text);
    options.appendChild(label);
  });

  renderQuestionNav();
}

function renderQuestionResource(resource){
  const box = document.getElementById('resourcePanel');
  if(!box) return;

  box.innerHTML = '';
  box.classList.add('hidden');
  if(!resource) return;

  box.classList.remove('hidden');

  if(resource.title){
    const title = document.createElement('h3');
    title.className = 'resource-title';
    title.textContent = resource.title;
    box.appendChild(title);
  }

  if(resource.instructions){
    const instructions = document.createElement('p');
    instructions.className = 'resource-instructions';
    instructions.textContent = resource.instructions;
    box.appendChild(instructions);
  }

  const type = String(resource.type || '').toUpperCase();
  if(type === 'PASSAGE'){
    const passage = document.createElement('div');
    passage.className = 'resource-passage';
    String(resource.content || '').split(/\n\s*\n/).forEach(p=>{
      if(!p.trim()) return;
      const para = document.createElement('p');
      para.textContent = p.trim();
      passage.appendChild(para);
    });
    box.appendChild(passage);
  }else if(type === 'TABLE'){
    box.appendChild(buildResourceTable(resource));
  }else if(resource.content){
    const content = document.createElement('div');
    content.className = 'resource-passage';
    content.textContent = resource.content;
    box.appendChild(content);
  }
}

function buildResourceTable(resource){
  const wrap = document.createElement('div');
  wrap.className = 'resource-table-wrap';
  const id = String(resource.id || '');
  const rows = resource.tableRows || [];

  if(id === 'RES_A_TABLE'){
    const table = document.createElement('table');
    table.className = 'resource-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Branch</th><th>Year 1</th><th>Year 2</th><th>Year 3</th><th>Year 4</th><th>Year 5</th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    rows.filter(r=>r.section === 'Operating Cost').forEach(r=>{
      const tr = document.createElement('tr');
      [r.rowLabel,r.col1,r.col2,r.col3,r.col4,r.col5].forEach(v=>{
        const td=document.createElement('td'); td.textContent=v; tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody); wrap.appendChild(table); return wrap;
  }

  if(id === 'RES_D_TABLE'){
    const summaries = {};
    const grades = {A:{},B:{},C:{}};
    rows.forEach(r=>{
      if(r.section === 'Mill Summary') summaries[r.rowLabel]=r;
      if(r.section === 'Grade A') grades.A[r.rowLabel]=r;
      if(r.section === 'Grade B') grades.B[r.rowLabel]=r;
      if(r.section === 'Grade C') grades.C[r.rowLabel]=r;
    });
    const table=document.createElement('table'); table.className='resource-table textile-table';
    const thead=document.createElement('thead');
    thead.innerHTML='<tr><th>Mill</th><th>Daily Capacity</th><th>Grade A<br>$140</th><th>Grade B<br>$115</th><th>Grade C<br>$95</th><th>Total Output</th></tr>';
    table.appendChild(thead);
    const tbody=document.createElement('tbody');
    ['Mill 1','Mill 2','Mill 3','Mill 4','Mill 5'].forEach(mill=>{
      const tr=document.createElement('tr');
      const vals=[mill, summaries[mill]?.col1 || '',
        formatGradeCell(grades.A[mill]), formatGradeCell(grades.B[mill]),
        formatGradeCell(grades.C[mill]), summaries[mill]?.col2 || ''];
      vals.forEach((v,i)=>{ const td=document.createElement('td'); td.textContent=v; if(i>=2&&i<=4) td.className='grade-cell'; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody); wrap.appendChild(table);
    const note=document.createElement('p'); note.className='resource-note';
    note.textContent='Each grade cell shows: output bolts · % of that grade total · % of that mill total.';
    wrap.appendChild(note); return wrap;
  }

  const pre=document.createElement('pre'); pre.className='resource-raw';
  pre.textContent=(resource.content || '') + '\n' + rows.map(r=>[r.section,r.rowLabel,r.col1,r.col2,r.col3,r.col4,r.col5,r.col6].filter(Boolean).join(' | ')).join('\n');
  wrap.appendChild(pre); return wrap;
}

function formatGradeCell(r){
  if(!r) return '';
  return [r.col1, r.col2 ? (r.col2 + '% grade') : '', r.col3 ? (r.col3 + '% mill') : ''].filter(Boolean).join(' · ');
}

function renderQuestionNav(){
  const nav =
    document.getElementById('questionNav');

  nav.innerHTML = '';

  questions.forEach((q,i)=>{
    const button =
      document.createElement('button');

    button.textContent =
      i + 1;

    if(answers[q.id]){
      button
        .classList
        .add('answered');
    }

    if(i === currentQuestion){
      button
        .classList
        .add('current');
    }

    button.addEventListener(
      'click',
      ()=>{
        currentQuestion = i;
        renderQuestion();
      }
    );

    nav.appendChild(button);
  });
}

function nextQuestion(){
  if(
    currentQuestion <
    questions.length - 1
  ){
    currentQuestion++;
    renderQuestion();
  }
}

function previousQuestion(){
  if(currentQuestion > 0){
    currentQuestion--;
    renderQuestion();
  }
}

/* ==================== TIMER ==================== */

function startTimer(){
  clearInterval(timerHandle);

  const tick = ()=>{
    const remaining =
      Math.max(
        0,
        endTimeMs - Date.now()
      );

    const totalSeconds =
      Math.floor(
        remaining / 1000
      );

    const mm =
      String(
        Math.floor(
          totalSeconds / 60
        )
      ).padStart(2,'0');

    const ss =
      String(
        totalSeconds % 60
      ).padStart(2,'0');

    document
      .getElementById('timer')
      .textContent =
        mm + ':' + ss;

    if(remaining <= 0){
      clearInterval(timerHandle);

      submitExam(
        'TIME_EXPIRED'
      );
    }
  };

  tick();

  timerHandle =
    setInterval(
      tick,
      500
    );
}

function startAutosave(){
  clearTimeout(autosaveHandle);

  const scheduleNext = ()=>{
    if(!examActive || submissionInProgress){
      return;
    }

    // Jitter prevents many candidates from autosaving at the same instant.
    const delayMs = 25000 + Math.floor(Math.random() * 10000);

    autosaveHandle = setTimeout(async ()=>{
      if(!examActive || submissionInProgress){
        return;
      }

      if(answersDirty){
        const versionAtStart = answerMutationVersion;

        try{
          const p = rpcWithRetry_(
            'saveAnswersBulk',
            {
              sessionId: session.sessionId,
              answers: answers
            },
            {timeoutMs:20000, retries:2, baseDelay:700, maxDelay:3000}
          );

          await trackSavePromise_(p);

          if(versionAtStart === answerMutationVersion){
            answersDirty = false;
          }
        }catch(e){
          // Keep answersDirty=true so the next cycle retries automatically.
        }
      }

      scheduleNext();
    }, delayMs);
  };

  scheduleNext();
}

function trackSavePromise_(promise){
  pendingSavePromises.add(promise);

  const cleanup = ()=>pendingSavePromises.delete(promise);
  promise.then(cleanup, cleanup);

  return promise;
}

async function waitForPendingSaves_(maxWaitMs){
  const started = Date.now();

  while(pendingSavePromises.size){
    const pending = Array.from(pendingSavePromises);
    const remaining = Math.max(0, Number(maxWaitMs || 10000) - (Date.now() - started));

    if(remaining <= 0){
      break;
    }

    await Promise.race([
      Promise.allSettled(pending),
      delay(Math.min(remaining, 1200))
    ]);
  }
}

async function rpcWithRetry_(action, payload, options){
  options = options || {};

  const retries = Math.max(0, Number(options.retries || 0));
  const timeoutMs = Math.max(5000, Number(options.timeoutMs || 30000));
  const baseDelay = Math.max(100, Number(options.baseDelay || 600));
  const maxDelay = Math.max(baseDelay, Number(options.maxDelay || 5000));

  let lastError = null;

  for(let attempt = 0; attempt <= retries; attempt++){
    try{
      return await rpc(action, payload, timeoutMs);
    }catch(err){
      lastError = err;

      if(attempt >= retries){
        break;
      }

      const exponential = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
      const jitter = Math.floor(Math.random() * Math.max(250, exponential));
      await delay(exponential + jitter);
    }
  }

  throw lastError || new Error('Server request failed.');
}

/* ==================== PROCTOR ==================== */

function clientState(){
  return {
    visibilityState:
      document.visibilityState,

    fullscreen:
      !!document.fullscreenElement,

    cameraActive:
      cameraActive(),

    userAgent:
      navigator.userAgent
  };
}

function registerViolation(
  type,
  details
){
  if(!examActive){
    return;
  }

  violationCount++;

  document
    .getElementById('violationCount')
    .textContent =
      violationCount;

  const q =
    questions[currentQuestion];

  rpc(
    'logEvent',
    {
      sessionId:
        session.sessionId,

      eventType:
        type,

      details:
        details,

      questionId:
        q ? q.id : '',

      violationCount:
        violationCount,

      clientState:
        clientState()
    }
  ).catch(()=>{});

  showWarning(
    'Violation ' +
    violationCount +
    ' of ' +
    publicConfig.maxViolations +
    ': ' +
    details
  );

  if(
    violationCount >=
    Number(
      publicConfig.maxViolations ||
      3
    )
  ){
    terminateExam(
      'Maximum permitted violations exceeded.'
    );
  }
}

function beginAway(
  reason,
  details
){
  if(
    !examActive ||
    awayStartedAt !== null
  ){
    return;
  }

  const now =
    Date.now();

  if(
    now -
    lastAwayCloseAt <
    600
  ){
    return;
  }

  awayStartedAt =
    now;

  awayReason =
    reason;

  registerViolation(
    reason,
    details
  );

  if(!examActive || submissionInProgress) return;

  clearTimeout(awayTimeoutHandle);

  const timeoutSeconds = Math.max(
    1,
    Number(
      (bootstrapConfig && bootstrapConfig.awayTimeoutSeconds) ||
      (publicConfig && publicConfig.awayTimeoutSeconds) ||
      30
    )
  );

  awayTimeoutHandle = setTimeout(()=>{
    if(examActive && !submissionInProgress && awayStartedAt !== null){
      terminateExam(
        'Candidate remained away from the assessment for ' +
        timeoutSeconds +
        ' seconds.'
      );
    }
  }, timeoutSeconds * 1000);
}

function endAway(){
  if(
    !examActive ||
    awayStartedAt === null
  ){
    return;
  }

  clearTimeout(awayTimeoutHandle);
  awayTimeoutHandle = null;

  const seconds =
    Math.max(
      1,
      Math.round(
        (
          Date.now() -
          awayStartedAt
        ) / 1000
      )
    );

  const q =
    questions[currentQuestion];

  rpc(
    'logEvent',
    {
      sessionId:
        session.sessionId,

      eventType:
        'SCREEN_RETURNED',

      details:
        'Returned after ' +
        seconds +
        ' second(s). Trigger: ' +
        (
          awayReason ||
          'unknown'
        ),

      questionId:
        q ? q.id : '',

      violationCount:
        violationCount,

      clientState:
        clientState()
    }
  ).catch(()=>{});

  awayStartedAt =
    null;

  awayReason =
    null;

  lastAwayCloseAt =
    Date.now();
}

document.addEventListener(
  'visibilitychange',
  ()=>{
    if(!examActive){
      return;
    }

    if(document.hidden){
      beginAway(
        'SCREEN_SWITCH',
        'Candidate switched away from the assessment.'
      );
    }else{
      endAway();
    }
  }
);

window.addEventListener(
  'blur',
  ()=>{
    if(
      !examActive ||
      document.hidden
    ){
      return;
    }

    setTimeout(
      ()=>{
        if(!examActive){
          return;
        }

        if(document.hidden){
          beginAway(
            'SCREEN_SWITCH',
            'Candidate switched away from the assessment.'
          );

        }else if(
          !document.hasFocus()
        ){
          beginAway(
            'WINDOW_FOCUS_LOST',
            'Assessment window lost focus.'
          );
        }
      },
      250
    );
  }
);

window.addEventListener(
  'focus',
  ()=>{
    if(
      examActive &&
      !document.hidden
    ){
      endAway();
    }
  }
);

document.addEventListener(
  'fullscreenchange',
  ()=>{
    if(!examActive){
      return;
    }

    if(
      !document.fullscreenElement
    ){
      if(
        !fullscreenViolationOpen
      ){
        fullscreenViolationOpen =
          true;

        registerViolation(
          'FULLSCREEN_EXIT',
          'Fullscreen mode was exited.'
        );
      }

    }else{
      fullscreenViolationOpen =
        false;
    }
  }
);

document.addEventListener(
  'contextmenu',
  e=>{
    if(examActive){
      e.preventDefault();

      registerViolation(
        'RIGHT_CLICK',
        'Right-click attempt detected.'
      );
    }
  }
);

document.addEventListener(
  'copy',
  e=>{
    if(examActive){
      e.preventDefault();

      registerViolation(
        'COPY_ATTEMPT',
        'Copy attempt detected.'
      );
    }
  }
);

document.addEventListener(
  'cut',
  e=>{
    if(examActive){
      e.preventDefault();

      registerViolation(
        'CUT_ATTEMPT',
        'Cut attempt detected.'
      );
    }
  }
);

document.addEventListener(
  'paste',
  e=>{
    if(examActive){
      e.preventDefault();

      registerViolation(
        'PASTE_ATTEMPT',
        'Paste attempt detected.'
      );
    }
  }
);

document.addEventListener(
  'keydown',
  e=>{
    if(!examActive){
      return;
    }

    const key =
      e.key.toLowerCase();

    const blocked =
      e.key === 'F12' ||
      (
        e.ctrlKey &&
        ['c','v','x','u','s','p']
          .includes(key)
      ) ||
      (
        e.ctrlKey &&
        e.shiftKey &&
        ['i','j','c']
          .includes(key)
      );

    if(blocked){
      e.preventDefault();

      registerViolation(
        'BLOCKED_SHORTCUT',
        'Restricted keyboard shortcut attempted.'
      );
    }

    if(
      e.key === 'PrintScreen'
    ){
      registerViolation(
        'PRINTSCREEN_KEY',
        'Print Screen key detected.'
      );
    }
  }
);

setInterval(
  ()=>{
    if(!examActive){
      return;
    }

    if(
      !cameraActive() &&
      !cameraViolationOpen
    ){
      cameraViolationOpen =
        true;

      registerViolation(
        'CAMERA_INACTIVE',
        'Camera is no longer active.'
      );
    }

    if(cameraActive()){
      cameraViolationOpen =
        false;
    }
  },
  3000
);

function showSubmitLoader(message){
  const overlay = document.getElementById('submitOverlay');
  if(!overlay){
    return;
  }

  const heading = overlay.querySelector('h2');
  if(heading && message){
    heading.textContent = message;
  }

  overlay.classList.remove('hidden');
}

function hideSubmitLoader(){
  const overlay = document.getElementById('submitOverlay');
  if(overlay){
    overlay.classList.add('hidden');
  }
}

/* ==================== SUBMIT ==================== */

function manualSubmit(){
  if(
    confirm(
      'Submit the assessment now?'
    )
  ){
    submitExam(
      'CANDIDATE_SUBMIT'
    );
  }
}

async function submitExam(reason){
  if(!examActive || submissionInProgress){
    return;
  }

  submissionInProgress = true;
  examActive = false;

  showSubmitLoader('Submitting Assessment…');

  clearInterval(timerHandle);
  clearTimeout(autosaveHandle);
  clearTimeout(awayTimeoutHandle);
  awayTimeoutHandle = null;

  try{
    // Finish any in-flight answer/autosave request before the final snapshot.
    // This prevents the last selected question racing the final submit.
    await waitForPendingSaves_(10000);

    // Small random stagger smooths a simultaneous 50-candidate submit spike.
    await delay(300 + Math.floor(Math.random() * 4200));

    // Final submission can legitimately take longer than a normal autosave.
    // Give Apps Script up to two minutes before treating it as delayed.
    const result = await rpcWithRetry_(
      'submitExam',
      {
        sessionId: session.sessionId,
        answers: answers,
        reason: reason,
        violationCount: violationCount
      },
      {timeoutMs:60000, retries:2, baseDelay:1200, maxDelay:6000}
    );

    submissionInProgress = false;
    finishExam(result);

  }catch(err){
    // A browser timeout does not prove that Apps Script failed. The server may
    // have finished just after the callback window closed, so verify status
    // before allowing the candidate to retry.
    showSubmitLoader('Confirming Submission…');

    const recovered = await recoverSubmissionStatus();
    if(recovered && recovered.completed){
      submissionInProgress = false;
      finishExam(recovered);
      return;
    }

    hideSubmitLoader();
    submissionInProgress = false;
    examActive = true;
    startTimer();
    startAutosave();

    alert(
      'The server has not yet confirmed your submission. Your answers remain on this screen. ' +
      'Please wait a few seconds and press Submit Exam again.\n\n' +
      (err.message || '')
    );
  }
}

async function recoverSubmissionStatus(){
  for(let attempt = 1; attempt <= 5; attempt++){
    try{
      const status = await rpc(
        'getSubmissionStatus',
        {sessionId: session.sessionId},
        20000
      );

      if(status && status.completed){
        return status;
      }
    }catch(e){}

    if(attempt < 5){
      await delay(2500);
    }
  }

  return null;
}

function delay(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function terminateExam(reason){
  if(!examActive || submissionInProgress){
    return;
  }

  submissionInProgress = true;
  examActive =
    false;

  showSubmitLoader('Finalizing Assessment…');

  clearInterval(
    timerHandle
  );

  clearTimeout(
    autosaveHandle
  );

  clearTimeout(awayTimeoutHandle);
  awayTimeoutHandle = null;

  try{
    await waitForPendingSaves_(8000);
    await delay(200 + Math.floor(Math.random() * 1800));

    const result =
      await rpcWithRetry_(
        'terminateExam',
        {
          sessionId:
            session.sessionId,

          answers:
            answers,

          reason:
            reason,

          violationCount:
            violationCount
        },
        {timeoutMs:60000, retries:2, baseDelay:1000, maxDelay:5000}
      );

    finishExam(
      result
    );

  }catch(err){
    finishExam(null);
  }
}

function finishExam(result){
  submissionInProgress = false;
  hideSubmitLoader();

  try{
    if(
      document.fullscreenElement
    ){
      document.exitFullscreen();
    }
  }catch(e){}

  if(mediaStream){
    mediaStream
      .getTracks()
      .forEach(
        t=>t.stop()
      );
  }

  document
    .getElementById('cameraPanel')
    .classList
    .add('hidden');

  const score =
    document.getElementById('scoreText');

  if(
    publicConfig.showScoreToCandidate &&
    result
  ){
    score.textContent =
      'Score: ' +
      result.score +
      ' / ' +
      result.maxScore;

  }else{
    score.textContent =
      '';
  }

  showView(
    'doneView'
  );
}

/* ==================== HELPERS ==================== */

function showView(id){
  [
    'loadingView',
    'loginView',
    'readyView',
    'examView',
    'doneView'
  ].forEach(
    v=>
      document
        .getElementById(v)
        .classList
        .add('hidden')
  );

  document
    .getElementById(id)
    .classList
    .remove('hidden');
}

function showFatal(text){
  document
    .getElementById('loadingView')
    .innerHTML =
      '<div class="card narrow">' +
      '<h1>Unable to Start</h1>' +
      '<div class="status bad">' +
      escapeHtml(text) +
      '</div>' +
      '</div>';
}

function showWarning(text){
  document
    .getElementById('warningMessage')
    .textContent =
      text;

  document
    .getElementById('warningOverlay')
    .classList
    .remove('hidden');
}

function closeWarning(){
  document
    .getElementById('warningOverlay')
    .classList
    .add('hidden');

  if(
    examActive &&
    !document.fullscreenElement
  ){
    document
      .documentElement
      .requestFullscreen()
      .then(()=>{
        fullscreenViolationOpen =
          false;
      })
      .catch(()=>{});
  }
}

function setText(id,text){
  document
    .getElementById(id)
    .textContent =
      text || '';
}

function escapeHtml(v){
  return String(v || '')
    .replace(
      /[&<>"']/g,
      c=>({
        '&':'&amp;',
        '<':'&lt;',
        '>':'&gt;',
        '"':'&quot;',
        "'":'&#039;'
      }[c])
    );
}

window.addEventListener(
  'beforeunload',
  e=>{
    if(examActive){
      e.preventDefault();
      e.returnValue = '';
    }
  }
);
