/*
 * PROCTOR EXAM v3.2 - NO BRIDGE
 *
 * IMPORTANT:
 * Replace this with the PERSONAL Apps Script /exec URL.
 */
const APPS_SCRIPT_WEB_APP_URL =
  'PASTE_YOUR_PERSONAL_APPS_SCRIPT_EXEC_URL_HERE';

let rpcCounter = 0;
const pendingRpc = new Map();

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
let lastAwayCloseAt = 0;
let cameraViolationOpen = false;
let fullscreenViolationOpen = false;

/* ==================== RPC ==================== */

window.addEventListener('load', async function(){
  if(APPS_SCRIPT_WEB_APP_URL.includes('PASTE_YOUR_')){
    showFatal(
      'Administrator setup incomplete: Apps Script Web App URL is missing in app.js.'
    );
    return;
  }

  try{
    publicConfig = await rpc('getPublicConfig', {});

    document.getElementById('appTitle').textContent =
      publicConfig.appTitle || 'Proctored Interview Assessment';

    showView('loginView');

  }catch(err){
    showFatal(
      'Unable to connect to examination server. ' +
      (err.message || '')
    );
  }
});

window.addEventListener('message', function(event){
  const data = event.data || {};

  if(
    data.type !== 'PROCTOR_RPC_RESPONSE' ||
    !data.id
  ){
    return;
  }

  const pending = pendingRpc.get(data.id);

  if(!pending){
    return;
  }

  pendingRpc.delete(data.id);

  cleanupRpcNode(data.id);

  if(data.ok){
    pending.resolve(data.result);
  }else{
    pending.reject(
      new Error(data.error || 'Backend error')
    );
  }
});

function rpc(action, payload){
  return new Promise((resolve, reject)=>{
    const id =
      'rpc_' +
      Date.now() +
      '_' +
      (++rpcCounter);

    pendingRpc.set(
      id,
      {resolve, reject}
    );

    const host =
      document.getElementById('rpcHost');

    const iframe =
      document.createElement('iframe');

    iframe.name = id;
    iframe.id = 'frame_' + id;
    iframe.style.display = 'none';

    const form =
      document.createElement('form');

    form.method = 'POST';
    form.action = APPS_SCRIPT_WEB_APP_URL;
    form.target = id;
    form.id = 'form_' + id;
    form.style.display = 'none';

    addHidden(form, 'id', id);
    addHidden(form, 'action', action);
    addHidden(
      form,
      'payload',
      JSON.stringify(payload || {})
    );

    host.appendChild(iframe);
    host.appendChild(form);

    form.submit();

    setTimeout(()=>{
      if(pendingRpc.has(id)){
        pendingRpc.delete(id);
        cleanupRpcNode(id);

        reject(
          new Error(
            'Server request timed out.'
          )
        );
      }
    }, 30000);
  });
}

function addHidden(form, name, value){
  const input =
    document.createElement('input');

  input.type = 'hidden';
  input.name = name;
  input.value = value;

  form.appendChild(input);
}

function cleanupRpcNode(id){
  const frame =
    document.getElementById('frame_' + id);

  const form =
    document.getElementById('form_' + id);

  if(frame){
    frame.remove();
  }

  if(form){
    form.remove();
  }
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

    showView('readyView');

  }catch(err){
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
    setText(
      'readyMsg',
      'Fullscreen permission is required. Please click Start Exam again.'
    );
    return;
  }

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
  const q =
    questions[currentQuestion];

  if(!q){
    return;
  }

  document
    .getElementById('qNum')
    .textContent =
      currentQuestion + 1;

  document
    .getElementById('questionLabel')
    .textContent =
      'Question ' +
      (currentQuestion + 1) +
      ' of ' +
      questions.length;

  document
    .getElementById('questionText')
    .textContent =
      q.question;

  const options =
    document.getElementById('options');

  options.innerHTML = '';

  q.options.forEach(o=>{
    const label =
      document.createElement('label');

    label.className =
      'option';

    const radio =
      document.createElement('input');

    radio.type =
      'radio';

    radio.name =
      'answer';

    radio.value =
      o.key;

    radio.checked =
      answers[q.id] === o.key;

    radio.addEventListener(
      'change',
      ()=>{
        answers[q.id] =
          o.key;

        renderQuestionNav();

        rpc(
          'saveAnswer',
          {
            sessionId:
              session.sessionId,

            questionId:
              q.id,

            answer:
              o.key
          }
        ).catch(()=>{});
      }
    );

    const text =
      document.createElement('span');

    text.textContent =
      o.key +
      '. ' +
      o.text;

    label.appendChild(radio);
    label.appendChild(text);

    options.appendChild(label);
  });

  renderQuestionNav();
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
  clearInterval(
    autosaveHandle
  );

  const seconds =
    Math.max(
      5,
      Number(
        publicConfig.autosaveSeconds ||
        10
      )
    );

  autosaveHandle =
    setInterval(
      ()=>{
        if(!examActive){
          return;
        }

        rpc(
          'saveAnswersBulk',
          {
            sessionId:
              session.sessionId,

            answers:
              answers
          }
        ).catch(()=>{});
      },
      seconds * 1000
    );
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
}

function endAway(){
  if(
    !examActive ||
    awayStartedAt === null
  ){
    return;
  }

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
  if(!examActive){
    return;
  }

  examActive =
    false;

  clearInterval(
    timerHandle
  );

  clearInterval(
    autosaveHandle
  );

  try{
    const result =
      await rpc(
        'submitExam',
        {
          sessionId:
            session.sessionId,

          answers:
            answers,

          reason:
            reason,

          violationCount:
            violationCount
        }
      );

    finishExam(
      result
    );

  }catch(err){
    examActive =
      true;

    alert(
      err.message
    );
  }
}

async function terminateExam(reason){
  if(!examActive){
    return;
  }

  examActive =
    false;

  clearInterval(
    timerHandle
  );

  clearInterval(
    autosaveHandle
  );

  try{
    const result =
      await rpc(
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
        }
      );

    finishExam(
      result
    );

  }catch(err){
    finishExam(null);
  }
}

function finishExam(result){
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
