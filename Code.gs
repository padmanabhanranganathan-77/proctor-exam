/**
 * PROCTOR EXAM v5.1 - SAFE SUBMISSION
 * Personal account backend.
 * Spreadsheet:
 * Live Spreadsheet: 1PTVxN_YvC6icka2LLjgb4O7hkwx5WpZoZXol2NWMssM
 *
 * Candidate UI is hosted on GitHub Pages.
 * Cross-origin RPC currently uses JSONP-style direct RPC for the GitHub Pages UI.
 */

const PROCTOR = {
  SPREADSHEET_ID: '1PTVxN_YvC6icka2LLjgb4O7hkwx5WpZoZXol2NWMssM',
  APP_TITLE: 'Proctored Interview Assessment'
};

const SHEETS = {
  CANDIDATES: 'CANDIDATES',
  QUESTIONS: 'QUESTION_BANK',
  CONFIG: 'EVALUATION_CONFIG',
  RESOURCES: 'QUESTION_RESOURCES',
  RESOURCE_DATA: 'RESOURCE_TABLE_DATA',
  SESSIONS: 'EXAM_SESSIONS',
  RESPONSES: 'EXAM_RESPONSES',
  LOG: 'PROCTOR_LOG'
};

function doGet(e) {
  const p = (e && e.parameter) ? e.parameter : {};
  const page = String(p.page || '').toLowerCase();

  if (page === 'admin') {
    return HtmlService.createHtmlOutputFromFile('Admin')
      .setTitle('Proctor Admin Dashboard');
  }

  // Normal health-check page.
  if (!p.action) {
    return HtmlService.createHtmlOutput(
      '<!doctype html><html><body style="font-family:Arial;padding:24px">' +
      '<h2>Proctor Exam Backend v5.1</h2>' +
      '<p>Backend is active.</p>' +
      '</body></html>'
    ).setTitle('Proctor Exam Backend');
  }

  // Cross-origin direct RPC (JSONP-style).
  const callback = String(p.callback || '').trim();
  const requestId = String(p.id || '').trim();
  const action = String(p.action || '').trim();

  if (!/^[A-Za-z_$][A-Za-z0-9_$\\.]*$/.test(callback)) {
    return ContentService
      .createTextOutput('Invalid callback.')
      .setMimeType(ContentService.MimeType.TEXT);
  }

  let payload = {};
  try {
    payload = JSON.parse(String(p.payload || '{}'));
  } catch (err) {
    return jsonp_(callback, {
      type: 'PROCTOR_RPC_RESPONSE',
      id: requestId,
      ok: false,
      result: null,
      error: 'Invalid request payload.'
    });
  }

  try {
    let result;

    switch (action) {
      case 'getPublicConfig':
        result = getPublicConfig();
        break;

      case 'loginCandidate':
        result = loginCandidate(payload.candidateId, payload.pin, payload.userAgent);
        break;

      case 'startExam':
        result = startExam(payload.sessionId, payload.clientState);
        break;

      case 'saveAnswer':
        result = saveAnswer(payload.sessionId, payload.questionId, payload.answer);
        break;

      case 'saveAnswersBulk':
        result = saveAnswersBulk(payload.sessionId, payload.answers);
        break;

      case 'logEvent':
        result = logEvent(
          payload.sessionId,
          payload.eventType,
          payload.details,
          payload.questionId,
          payload.violationCount,
          payload.clientState
        );
        break;

      case 'getSubmissionStatus':
        result = getSubmissionStatus(payload.sessionId);
        break;

      case 'submitExam':
        result = submitExam(
          payload.sessionId,
          payload.answers,
          payload.reason,
          payload.violationCount
        );
        break;

      case 'terminateExam':
        result = terminateExam(
          payload.sessionId,
          payload.answers,
          payload.reason,
          payload.violationCount
        );
        break;

      default:
        throw new Error('Unsupported action.');
    }

    return jsonp_(callback, {
      type: 'PROCTOR_RPC_RESPONSE',
      id: requestId,
      ok: true,
      result: result || null,
      error: null
    });

  } catch (err) {
    return jsonp_(callback, {
      type: 'PROCTOR_RPC_RESPONSE',
      id: requestId,
      ok: false,
      result: null,
      error: err && err.message ? err.message : String(err)
    });
  }
}

function jsonp_(callback, obj) {
  const json = JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  return ContentService
    .createTextOutput(callback + '(' + json + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}



function getPublicConfig() {
  const cfg = getConfig_();

  return {
    appTitle: cfg.TestName || PROCTOR.APP_TITLE,
    durationMinutes: Math.max(1, num_(cfg.DurationMinutes, 65)),
    maxViolations: Math.max(1, num_(cfg.MaxViolations, 3)),

    // This assessment contains shared tables/passages. Keep the original
    // Part A-E / Q1-Q40 sequence unless a future master explicitly changes it.
    randomizeQuestions: bool_(cfg.RandomizeQuestions, false),
    randomizeOptions: bool_(cfg.RandomizeOptions, false),

    autosaveSeconds: Math.max(5, num_(cfg.AutosaveSeconds, 10)),
    showScoreToCandidate: bool_(cfg.ShowScoreToCandidate, false),
    totalQuestions: Math.max(1, num_(cfg.TotalQuestions, 40)),
    maxScore: Math.max(0, num_(cfg.MaxScore, 40))
  };
}

function loginCandidate(candidateId, pin, userAgent) {
  candidateId = String(candidateId || '').trim();
  pin = String(pin || '').trim();

  if (!candidateId || !pin) {
    throw new Error('Candidate ID and PIN are required.');
  }

  const ss = SpreadsheetApp.openById(PROCTOR.SPREADSHEET_ID);
  const sh = ss.getSheetByName(SHEETS.CANDIDATES);

  if (!sh) {
    throw new Error('CANDIDATES sheet not found. Run setupProctorApp().');
  }

  const data = sh.getDataRange().getValues();
  const headers = data.shift();
  const idx = headerMap_(headers);

  const row = data.find(r =>
    String(r[idx['Candidate ID']] || '').trim().toLowerCase() ===
    candidateId.toLowerCase()
  );

  if (!row || String(row[idx['PIN']] || '').trim() !== pin) {
    throw new Error('Invalid Candidate ID or PIN.');
  }

  if (!bool_(row[idx['Active']], false)) {
    throw new Error('Candidate is not active.');
  }

  const allowedAttempts = Math.max(
    1,
    num_(row[idx['Allowed Attempts']], 1)
  );

  if (getCandidateAttemptCount_(candidateId) >= allowedAttempts) {
    throw new Error('Maximum allowed attempts already used.');
  }

  const candidateName =
    String(row[idx['Candidate Name']] || candidateId);

  const sessionId = Utilities.getUuid();
  const now = new Date();
  const cfg = getPublicConfig();

  ss.getSheetByName(SHEETS.SESSIONS).appendRow([
    sessionId,
    candidateId,
    candidateName,
    '',
    '',
    'READY',
    cfg.durationMinutes,
    0,
    '',
    '',
    now,
    String(userAgent || '')
  ]);

  return {
    sessionId: sessionId,
    candidateId: candidateId,
    candidateName: candidateName,
    config: cfg
  };
}

function startExam(sessionId, clientState) {
  const session = getSession_(sessionId);

  if (!session) throw new Error('Invalid exam session.');

  if (String(session['Status']) !== 'READY') {
    throw new Error('This session cannot be started.');
  }

  clientState = clientState || {};

  if (!clientState.cameraActive) {
    throw new Error('Camera must be active before the exam can start.');
  }

  const cfg = getPublicConfig();
  const start = new Date();
  const end = new Date(
    start.getTime() + cfg.durationMinutes * 60000
  );

  updateSessionFields_(sessionId, {
    'Start Time': start,
    'Status': 'IN_PROGRESS',
    'Last Seen': start,
    'User Agent': String(clientState.userAgent || '')
  });

  appendLog_(
    sessionId,
    session['Candidate ID'],
    'EXAM_STARTED',
    'Exam started',
    '',
    0,
    String(clientState.visibilityState || 'visible'),
    !!clientState.fullscreen,
    !!clientState.cameraActive
  );

  return {
    questions: loadQuestions_(
      cfg.randomizeQuestions,
      cfg.randomizeOptions
    ),
    serverStartTime: start.toISOString(),
    serverEndTime: end.toISOString(),
    durationMinutes: cfg.durationMinutes
  };
}

function saveAnswer(sessionId, questionId, answer) {
  const session = requireActiveSession_(sessionId);
  const q = getQuestionById_(questionId);

  if (!q || !q.active) {
    throw new Error('Question not found.');
  }

  const ss = SpreadsheetApp.openById(PROCTOR.SPREADSHEET_ID);
  const sh = ss.getSheetByName(SHEETS.RESPONSES);

  const correct =
    String(answer || '').trim().toUpperCase() ===
    String(q.correctOption || '').trim().toUpperCase();

  const marks = correct ? num_(q.marks, 0) : 0;

  upsertResponse_(sh, [
    sessionId,
    session['Candidate ID'],
    String(questionId),
    String(answer || ''),
    correct,
    marks,
    new Date()
  ]);

  updateSessionFields_(sessionId, {
    'Last Seen': new Date()
  });

  return {ok:true};
}

function saveAnswersBulk(sessionId, answers) {
  const session = requireActiveSession_(sessionId);
  answers = answers || {};

  const qids = Object.keys(answers);
  if (!qids.length) return {ok:true, saved:0};

  const ss = SpreadsheetApp.openById(PROCTOR.SPREADSHEET_ID);
  const qSh = ss.getSheetByName(SHEETS.QUESTIONS);
  const rSh = ss.getSheetByName(SHEETS.RESPONSES);

  if (!qSh || !rSh) {
    throw new Error('Question/response sheet not found.');
  }

  // Read question metadata once instead of re-reading the workbook for
  // every answer. This is important for final submission performance.
  const qData = qSh.getDataRange().getValues();
  const qHeaders = qData.shift();
  const qi = headerMap_(qHeaders);
  const qMeta = {};

  qData.forEach(r => {
    const id = String(r[qi.QuestionID] || '').trim();
    if (!id) return;
    qMeta[id] = {
      correctOption: String(r[qi.CorrectOption] || '').trim().toUpperCase(),
      marks: num_(r[qi.Marks], 0),
      active: bool_(r[qi.Active], false)
    };
  });

  const responseData = rSh.getDataRange().getValues();
  const headers = responseData[0] || [];
  const ri = headerMap_(headers);
  const existingRows = {};

  for (let r = 1; r < responseData.length; r++) {
    if (String(responseData[r][ri['Session ID']]) === String(sessionId)) {
      existingRows[String(responseData[r][ri['Question ID']])] = r + 1;
    }
  }

  const now = new Date();
  const newRows = [];
  let saved = 0;

  qids.forEach(qid => {
    const q = qMeta[String(qid)];
    if (!q || !q.active) return;

    const answer = String(answers[qid] || '').trim().toUpperCase();
    if (!answer) return;

    const correct = answer === q.correctOption;
    const row = [
      sessionId,
      session['Candidate ID'],
      String(qid),
      answer,
      correct,
      correct ? q.marks : 0,
      now
    ];

    const rowNo = existingRows[String(qid)];
    if (rowNo) {
      rSh.getRange(rowNo, 1, 1, row.length).setValues([row]);
    } else {
      newRows.push(row);
    }
    saved++;
  });

  if (newRows.length) {
    rSh.getRange(rSh.getLastRow() + 1, 1, newRows.length, newRows[0].length)
      .setValues(newRows);
  }

  updateSessionFields_(sessionId, {'Last Seen': now});
  return {ok:true, saved:saved};
}

function logEvent(
  sessionId,
  eventType,
  details,
  questionId,
  violationCount,
  clientState
) {
  const session = getSession_(sessionId);

  if (!session) {
    throw new Error('Invalid session.');
  }

  clientState = clientState || {};

  appendLog_(
    sessionId,
    session['Candidate ID'],
    String(eventType || ''),
    String(details || ''),
    String(questionId || ''),
    num_(violationCount, 0),
    String(clientState.visibilityState || ''),
    !!clientState.fullscreen,
    !!clientState.cameraActive
  );

  updateSessionFields_(sessionId, {
    'Violation Count': num_(violationCount, 0),
    'Last Seen': new Date()
  });

  return {ok:true};
}

function submitExam(sessionId, answers, reason, violationCount) {
  const session = getSession_(sessionId);

  if (!session) {
    throw new Error('Invalid session.');
  }

  // Idempotent finalisation: a retry after a slow/late browser response must
  // never score or submit the same session twice.
  if (
    String(session['Status']) === 'SUBMITTED' ||
    String(session['Status']) === 'TERMINATED'
  ) {
    return submissionResultFromSession_(session);
  }

  try {
    if (answers && typeof answers === 'object') {
      saveAnswersBulk(sessionId, answers);
    }
  } catch (e) {}

  const score = calculateScore_(sessionId);
  const now = new Date();

  updateSessionFields_(sessionId, {
    'End Time': now,
    'Status': 'SUBMITTED',
    'Violation Count': num_(
      violationCount,
      session['Violation Count'] || 0
    ),
    'Score': score.score,
    'Max Score': score.maxScore,
    'Last Seen': now
  });

  saveScoreBreakdownToSession_(sessionId, score);

  appendLog_(
    sessionId,
    session['Candidate ID'],
    'EXAM_SUBMITTED',
    String(reason || 'Candidate submitted'),
    '',
    num_(violationCount, session['Violation Count'] || 0),
    'visible',
    false,
    false
  );

  return score;
}

function terminateExam(
  sessionId,
  answers,
  reason,
  violationCount
) {
  const session = getSession_(sessionId);

  if (!session) {
    throw new Error('Invalid session.');
  }

  if (
    String(session['Status']) === 'SUBMITTED' ||
    String(session['Status']) === 'TERMINATED'
  ) {
    return submissionResultFromSession_(session);
  }

  try {
    if (answers && typeof answers === 'object') {
      saveAnswersBulk(sessionId, answers);
    }
  } catch (e) {}

  const score = calculateScore_(sessionId);
  const now = new Date();

  updateSessionFields_(sessionId, {
    'End Time': now,
    'Status': 'TERMINATED',
    'Violation Count': num_(violationCount, 0),
    'Score': score.score,
    'Max Score': score.maxScore,
    'Last Seen': now
  });

  saveScoreBreakdownToSession_(sessionId, score);

  appendLog_(
    sessionId,
    session['Candidate ID'],
    'EXAM_TERMINATED',
    String(reason || 'Maximum violations exceeded'),
    '',
    num_(violationCount, 0),
    'hidden',
    false,
    false
  );

  return score;
}

function getAdminSummary() {
  const ss = SpreadsheetApp.openById(PROCTOR.SPREADSHEET_ID);
  const sh = ss.getSheetByName(SHEETS.SESSIONS);

  if (!sh || sh.getLastRow() < 2) return [];

  const data = sh.getDataRange().getValues();
  const headers = data.shift();

  return data.map(r => {
    const o = {};

    headers.forEach((h, i) => {
      const v = r[i];

      o[h] = v instanceof Date
        ? Utilities.formatDate(
            v,
            Session.getScriptTimeZone(),
            'yyyy-MM-dd HH:mm:ss'
          )
        : v;
    });

    return o;
  }).reverse();
}

function ensureSheet_(ss, name, headers, sampleRows) {
  let sh = ss.getSheetByName(name);

  if (!sh) {
    sh = ss.insertSheet(name);
  }

  if (sh.getLastRow() === 0) {
    sh.getRange(1,1,1,headers.length)
      .setValues([headers])
      .setFontWeight('bold');

    sh.setFrozenRows(1);

    if (sampleRows && sampleRows.length) {
      sh.getRange(
        2,
        1,
        sampleRows.length,
        headers.length
      ).setValues(sampleRows);
    }

    sh.autoResizeColumns(1, headers.length);
  }

  return sh;
}

function getConfig_() {
  const ss = SpreadsheetApp.openById(PROCTOR.SPREADSHEET_ID);
  const sh = ss.getSheetByName(SHEETS.CONFIG);
  const out = {};

  if (!sh || sh.getLastRow() < 2) return out;

  sh.getRange(
    2,
    1,
    sh.getLastRow() - 1,
    2
  ).getValues().forEach(r => {
    const key = String(r[0] || '').trim();
    if (key) out[key] = r[1];
  });

  return out;
}

/**
 * Candidate-safe question loader.
 * IMPORTANT: CorrectOption and Explanation_ServerOnly are NEVER returned.
 */

function loadQuestions_(randomizeQuestions, randomizeOptions) {
  const ss = SpreadsheetApp.openById(PROCTOR.SPREADSHEET_ID);
  const sh = ss.getSheetByName(SHEETS.QUESTIONS);

  if (!sh || sh.getLastRow() < 2) return [];

  // Display values preserve $3,300 / 10% / 11:00 exactly as intended.
  const data = sh.getDataRange().getDisplayValues();
  const headers = data.shift();
  const idx = headerMap_(headers);
  const resources = loadQuestionResources_(ss);

  const required = [
    'QuestionID','Part','QuestionNo','ResourceID','QuestionText',
    'OptionA','OptionB','OptionC','OptionD','OptionE',
    'Active','DisplayOrder'
  ];
  required.forEach(h => {
    if (idx[h] === undefined) {
      throw new Error('QUESTION_BANK is missing required column: ' + h);
    }
  });

  let qs = data
    .filter(r => bool_(r[idx.Active], false))
    .map(r => {
      const resourceId = String(r[idx.ResourceID] || '').trim();

      return {
        id: String(r[idx.QuestionID] || '').trim(),
        part: String(r[idx.Part] || '').trim(),
        questionNo: num_(r[idx.QuestionNo], 0),
        question: String(r[idx.QuestionText] || ''),
        options: [
          {key:'A', text:String(r[idx.OptionA] || '')},
          {key:'B', text:String(r[idx.OptionB] || '')},
          {key:'C', text:String(r[idx.OptionC] || '')},
          {key:'D', text:String(r[idx.OptionD] || '')},
          {key:'E', text:String(r[idx.OptionE] || '')}
        ].filter(o => o.text),
        sequence: num_(r[idx.DisplayOrder], 999999),
        resourceId: resourceId,
        resource: resourceId && resources[resourceId]
          ? resources[resourceId]
          : null
      };
    });

  qs.sort((a,b) => a.sequence - b.sequence);

  if (randomizeQuestions) {
    // Keep question grouping by Part/resource safe. Randomize only within Part.
    const partOrder = ['A','B','C','D','E'];
    const grouped = {};
    partOrder.forEach(p => grouped[p] = []);
    qs.forEach(q => {
      if (!grouped[q.part]) grouped[q.part] = [];
      grouped[q.part].push(q);
    });
    qs = [];
    partOrder.forEach(p => {
      const arr = grouped[p] || [];
      qs = qs.concat(shuffle_(arr));
    });
  }

  if (randomizeOptions) {
    qs.forEach(q => {
      q.options = shuffle_(q.options);
    });
  }

  return qs;
}

/**
 * Loads candidate-visible common passages/tables.
 * No answer key or solution/explanation is exposed here.
 */
function loadQuestionResources_(ss) {
  const out = {};
  const rSh = ss.getSheetByName(SHEETS.RESOURCES);

  if (rSh && rSh.getLastRow() >= 2) {
    const data = rSh.getDataRange().getDisplayValues();
    const headers = data.shift();
    const idx = headerMap_(headers);

    data.forEach(r => {
      const id = String(r[idx.ResourceID] || '').trim();
      if (!id) return;

      out[id] = {
        id: id,
        part: String(r[idx.Part] || ''),
        type: String(r[idx.ResourceType] || ''),
        title: String(r[idx.Title] || ''),
        instructions: String(r[idx.Instructions] || ''),
        content: String(r[idx.Content] || ''),
        tableRows: []
      };
    });
  }

  const dSh = ss.getSheetByName(SHEETS.RESOURCE_DATA);
  if (dSh && dSh.getLastRow() >= 2) {
    const data = dSh.getDataRange().getDisplayValues();
    const headers = data.shift();
    const idx = headerMap_(headers);

    data.forEach(r => {
      const id = String(r[idx.ResourceID] || '').trim();
      if (!id || !out[id]) return;

      out[id].tableRows.push({
        section: String(r[idx.Section] || ''),
        rowLabel: String(r[idx.RowLabel] || ''),
        col1: String(r[idx.Col1] || ''),
        col2: String(r[idx.Col2] || ''),
        col3: String(r[idx.Col3] || ''),
        col4: String(r[idx.Col4] || ''),
        col5: String(r[idx.Col5] || ''),
        col6: String(r[idx.Col6] || ''),
        notes: String(r[idx.Notes] || '')
      });
    });
  }

  return out;
}

/**
 * Server-only question lookup used for scoring.
 */
function getQuestionById_(questionId) {
  const ss = SpreadsheetApp.openById(PROCTOR.SPREADSHEET_ID);
  const sh = ss.getSheetByName(SHEETS.QUESTIONS);

  if (!sh || sh.getLastRow() < 2) return null;

  const data = sh.getDataRange().getValues();
  const headers = data.shift();
  const idx = headerMap_(headers);

  for (const r of data) {
    if (String(r[idx.QuestionID]) === String(questionId)) {
      return {
        id: String(questionId),
        part: String(r[idx.Part] || ''),
        questionNo: num_(r[idx.QuestionNo], 0),
        correctOption: String(r[idx.CorrectOption] || ''),
        marks: num_(r[idx.Marks], 0),
        active: bool_(r[idx.Active], false)
      };
    }
  }

  return null;
}

function getSubmissionStatus(sessionId) {
  const session = getSession_(sessionId);
  if (!session) {
    throw new Error('Invalid session.');
  }
  return submissionResultFromSession_(session);
}

function submissionResultFromSession_(session) {
  const status = String(session['Status'] || '');
  return {
    status: status,
    completed: status === 'SUBMITTED' || status === 'TERMINATED',
    score: num_(session['Score'], 0),
    maxScore: num_(session['Max Score'], 0),
    percentage: num_(session['Percentage'], 0),
    unanswered: num_(session['Unanswered'], 0),
    violationCount: num_(session['Violation Count'], 0),
    endTime: session['End Time'] instanceof Date
      ? session['End Time'].toISOString()
      : String(session['End Time'] || '')
  };
}

function getSession_(sessionId) {
  const ss = SpreadsheetApp.openById(PROCTOR.SPREADSHEET_ID);
  const sh = ss.getSheetByName(SHEETS.SESSIONS);

  if (!sh || sh.getLastRow() < 2) return null;

  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idx = headerMap_(headers);

  for (let r = 1; r < data.length; r++) {
    if (
      String(data[r][idx['Session ID']]) ===
      String(sessionId)
    ) {
      const o = {};

      headers.forEach((h, i) => {
        o[h] = data[r][i];
      });

      return o;
    }
  }

  return null;
}

function requireActiveSession_(sessionId) {
  const session = getSession_(sessionId);

  if (!session) {
    throw new Error('Invalid exam session.');
  }

  if (String(session['Status']) !== 'IN_PROGRESS') {
    throw new Error('Exam session is not active.');
  }

  return session;
}

function updateSessionFields_(sessionId, fields) {
  const ss = SpreadsheetApp.openById(PROCTOR.SPREADSHEET_ID);
  const sh = ss.getSheetByName(SHEETS.SESSIONS);

  if (!sh || sh.getLastRow() < 2) return false;

  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idx = headerMap_(headers);

  let rowNo = -1;

  for (let r = 1; r < data.length; r++) {
    if (
      String(data[r][idx['Session ID']]) ===
      String(sessionId)
    ) {
      rowNo = r + 1;
      break;
    }
  }

  if (rowNo < 0) return false;

  // Update the complete session row in one write. The previous version
  // performed one Sheet write per field, which made final submission slower.
  const rowValues = data[rowNo - 1].slice();
  Object.keys(fields).forEach(k => {
    if (idx[k] !== undefined) {
      rowValues[idx[k]] = fields[k];
    }
  });

  sh.getRange(rowNo, 1, 1, headers.length).setValues([rowValues]);
  return true;
}

function upsertResponse_(sh, row) {
  const data = sh.getDataRange().getValues();
  const headers = data[0] || [];
  const idx = headerMap_(headers);

  for (let r = 1; r < data.length; r++) {
    if (
      String(data[r][idx['Session ID']]) === String(row[0]) &&
      String(data[r][idx['Question ID']]) === String(row[2])
    ) {
      sh.getRange(
        r + 1,
        1,
        1,
        row.length
      ).setValues([row]);

      return;
    }
  }

  sh.appendRow(row);
}

function appendLog_(
  sessionId,
  candidateId,
  eventType,
  details,
  questionId,
  violationCount,
  visibilityState,
  fullscreen,
  cameraActive
) {
  const ss = SpreadsheetApp.openById(PROCTOR.SPREADSHEET_ID);

  ss.getSheetByName(SHEETS.LOG).appendRow([
    new Date(),
    sessionId,
    candidateId,
    eventType,
    details,
    questionId,
    violationCount,
    visibilityState,
    fullscreen,
    cameraActive
  ]);
}

function getCandidateAttemptCount_(candidateId) {
  const ss = SpreadsheetApp.openById(PROCTOR.SPREADSHEET_ID);
  const sh = ss.getSheetByName(SHEETS.SESSIONS);

  if (!sh || sh.getLastRow() < 2) return 0;

  const data = sh.getDataRange().getValues();
  const headers = data.shift();
  const idx = headerMap_(headers);

  return data.filter(r =>
    String(r[idx['Candidate ID']]) === String(candidateId) &&
    ['IN_PROGRESS','SUBMITTED','TERMINATED']
      .includes(String(r[idx['Status']]))
  ).length;
}

function calculateScore_(sessionId) {
  const ss = SpreadsheetApp.openById(PROCTOR.SPREADSHEET_ID);
  const qSh = ss.getSheetByName(SHEETS.QUESTIONS);

  let maxScore = 0;
  const qMeta = {};
  const partMax = {A:0, B:0, C:0, D:0, E:0};

  if (qSh && qSh.getLastRow() >= 2) {
    const data = qSh.getDataRange().getValues();
    const headers = data.shift();
    const idx = headerMap_(headers);

    data.forEach(r => {
      if (!bool_(r[idx.Active], false)) return;

      const id = String(r[idx.QuestionID] || '');
      const part = String(r[idx.Part] || '').toUpperCase();
      const marks = num_(r[idx.Marks], 0);

      qMeta[id] = {part:part, marks:marks};
      maxScore += marks;
      if (partMax[part] !== undefined) partMax[part] += marks;
    });
  }

  let score = 0;
  let answered = 0;
  let correctCount = 0;
  const partScores = {A:0, B:0, C:0, D:0, E:0};
  const seen = {};

  const rSh = ss.getSheetByName(SHEETS.RESPONSES);
  if (rSh && rSh.getLastRow() >= 2) {
    const data = rSh.getDataRange().getValues();
    const headers = data.shift();
    const idx = headerMap_(headers);

    data.forEach(r => {
      if (String(r[idx['Session ID']]) !== String(sessionId)) return;

      const qid = String(r[idx['Question ID']] || '');
      if (!qid || seen[qid]) return;
      seen[qid] = true;

      const selected = String(r[idx['Answer']] || '').trim();
      if (selected) answered++;

      const marksAwarded = num_(r[idx['Marks Awarded']], 0);
      score += marksAwarded;

      if (bool_(r[idx['Is Correct']], false)) correctCount++;

      const meta = qMeta[qid];
      if (meta && partScores[meta.part] !== undefined) {
        partScores[meta.part] += marksAwarded;
      }
    });
  }

  const totalQuestions = Object.keys(qMeta).length;
  const unanswered = Math.max(0, totalQuestions - answered);
  const percentage = maxScore > 0 ? (score / maxScore) * 100 : 0;

  return {
    score: score,
    maxScore: maxScore,
    correctCount: correctCount,
    totalQuestions: totalQuestions,
    answered: answered,
    unanswered: unanswered,
    percentage: Math.round(percentage * 100) / 100,
    parts: {
      A: {score:partScores.A, max:partMax.A},
      B: {score:partScores.B, max:partMax.B},
      C: {score:partScores.C, max:partMax.C},
      D: {score:partScores.D, max:partMax.D},
      E: {score:partScores.E, max:partMax.E}
    }
  };
}

/**
 * Adds optional result columns to EXAM_SESSIONS once, without disturbing
 * the existing columns used by the live app.
 */
function ensureSessionResultColumns_() {
  const ss = SpreadsheetApp.openById(PROCTOR.SPREADSHEET_ID);
  const sh = ss.getSheetByName(SHEETS.SESSIONS);
  if (!sh) return;

  const existing = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const needed = [
    'Part A Score','Part B Score','Part C Score','Part D Score','Part E Score',
    'Percentage','Unanswered'
  ];

  needed.forEach(h => {
    if (existing.indexOf(h) === -1) {
      sh.getRange(1, sh.getLastColumn() + 1).setValue(h).setFontWeight('bold');
      existing.push(h);
    }
  });
}

function saveScoreBreakdownToSession_(sessionId, score) {
  ensureSessionResultColumns_();
  updateSessionFields_(sessionId, {
    'Part A Score': score.parts.A.score,
    'Part B Score': score.parts.B.score,
    'Part C Score': score.parts.C.score,
    'Part D Score': score.parts.D.score,
    'Part E Score': score.parts.E.score,
    'Percentage': score.percentage,
    'Unanswered': score.unanswered
  });
}

function headerMap_(headers) {
  const m = {};

  headers.forEach((h, i) => {
    m[String(h).trim()] = i;
  });

  return m;
}

function bool_(v, fallback) {
  if (
    v === true ||
    String(v).toLowerCase() === 'true' ||
    String(v) === '1'
  ) return true;

  if (
    v === false ||
    String(v).toLowerCase() === 'false' ||
    String(v) === '0'
  ) return false;

  return fallback;
}

function num_(v, fallback) {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

function shuffle_(arr) {
  const a = arr.slice();

  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(
      Math.random() * (i + 1)
    );

    [a[i], a[j]] = [a[j], a[i]];
  }

  return a;
}

/*******************************************************
 * PROCTOR EXAM - MASTER QUESTION BANK IMPORT
 *
 * SOURCE MASTER SHEET:
 * 17YKECeUwmvjkANZ-B1XQ_hKW860SgZfG-WJmVEYGO1Q
 *
 * This function updates ONLY:
 *   QUESTION_BANK
 *   QUESTION_RESOURCES
 *   RESOURCE_TABLE_DATA
 *   EVALUATION_CONFIG
 *
 * It does NOT touch:
 *   CANDIDATES
 *   EXAM_SESSIONS
 *   EXAM_RESPONSES
 *   PROCTOR_LOG
 *******************************************************/

var PROCTOR_MASTER_CONFIG = {
  SOURCE_SPREADSHEET_ID:
    '17YKECeUwmvjkANZ-B1XQ_hKW860SgZfG-WJmVEYGO1Q',

  IMPORT_SHEETS: [
    'QUESTION_BANK',
    'QUESTION_RESOURCES',
    'RESOURCE_TABLE_DATA',
    'EVALUATION_CONFIG'
  ],

  EXPECTED_QUESTION_COUNT: 40
};


/**
 * Run this manually from Apps Script
 * OR attach it to an Admin menu.
 */
function importQuestionBankFromMaster() {

  var targetSS = SpreadsheetApp.getActiveSpreadsheet();

  try {

    // ---------------------------------------------------
    // 1. OPEN MASTER
    // ---------------------------------------------------

    var sourceSS = SpreadsheetApp.openById(
      PROCTOR_MASTER_CONFIG.SOURCE_SPREADSHEET_ID
    );

    if (!sourceSS) {
      throw new Error(
        'Unable to open Master Question Bank spreadsheet.'
      );
    }


    // ---------------------------------------------------
    // 2. VALIDATE SOURCE SHEETS
    // ---------------------------------------------------

    PROCTOR_MASTER_CONFIG.IMPORT_SHEETS.forEach(
      function(sheetName) {

        var sh = sourceSS.getSheetByName(sheetName);

        if (!sh) {
          throw new Error(
            'Required source sheet missing: ' + sheetName
          );
        }

      }
    );


    // ---------------------------------------------------
    // 3. VALIDATE QUESTION BANK
    // ---------------------------------------------------

    var validationResult =
      validateMasterQuestionBank_(sourceSS);

    if (!validationResult.ok) {

      throw new Error(
        'Question Bank validation failed:\n\n' +
        validationResult.errors.join('\n')
      );

    }


    // ---------------------------------------------------
    // 4. COPY ALL CONFIG / QUESTION SHEETS
    // ---------------------------------------------------

    PROCTOR_MASTER_CONFIG.IMPORT_SHEETS.forEach(
      function(sheetName) {

        copyMasterSheetToLive_(
          sourceSS,
          targetSS,
          sheetName
        );

      }
    );


    // ---------------------------------------------------
    // 5. CREATE IMPORT LOG
    // ---------------------------------------------------

    logQuestionImport_(
      targetSS,
      validationResult.questionCount,
      'SUCCESS',
      'Question bank imported successfully.'
    );


    SpreadsheetApp.flush();


    // ---------------------------------------------------
    // 6. SUCCESS MESSAGE
    // ---------------------------------------------------

    var msg =
      'Question Bank Import Completed Successfully.\n\n' +
      'Questions imported: ' +
      validationResult.questionCount +
      '\n\n' +
      'Updated sheets:\n' +
      PROCTOR_MASTER_CONFIG.IMPORT_SHEETS.join('\n');

    Logger.log(msg);

    try {

      SpreadsheetApp
        .getUi()
        .alert(
          'Import Completed',
          msg,
          SpreadsheetApp.getUi().ButtonSet.OK
        );

    } catch (uiErr) {
      // Ignore if executed outside spreadsheet UI
    }


    return {
      success: true,
      message: msg
    };


  } catch (err) {

    // ---------------------------------------------------
    // ERROR LOG
    // ---------------------------------------------------

    try {

      logQuestionImport_(
        targetSS,
        0,
        'FAILED',
        err.message
      );

    } catch (logErr) {
      // Ignore secondary logging failure
    }


    Logger.log(
      'Question Bank Import Failed: ' +
      err.message
    );


    try {

      SpreadsheetApp
        .getUi()
        .alert(
          'Import Failed',
          err.message,
          SpreadsheetApp.getUi().ButtonSet.OK
        );

    } catch (uiErr) {
      // Ignore if no UI available
    }


    throw err;

  }

}



/**
 * VALIDATE MASTER QUESTION BANK
 */
function validateMasterQuestionBank_(sourceSS) {

  var errors = [];

  var questionSheet =
    sourceSS.getSheetByName('QUESTION_BANK');

  var data =
    questionSheet.getDataRange().getValues();

  if (data.length < 2) {

    errors.push(
      'QUESTION_BANK contains no question data.'
    );

    return {
      ok: false,
      errors: errors,
      questionCount: 0
    };

  }


  var headers = data[0];

  var requiredHeaders = [
    'QuestionID',
    'Part',
    'QuestionNo',
    'ResourceID',
    'QuestionText',
    'OptionA',
    'OptionB',
    'OptionC',
    'OptionD',
    'OptionE',
    'CorrectOption',
    'Marks',
    'Active',
    'DisplayOrder'
  ];


  requiredHeaders.forEach(function(h) {

    if (headers.indexOf(h) === -1) {

      errors.push(
        'Missing QUESTION_BANK column: ' + h
      );

    }

  });


  if (errors.length > 0) {

    return {
      ok: false,
      errors: errors,
      questionCount: 0
    };

  }


  // Column indexes
  var idx = {};

  requiredHeaders.forEach(function(h) {
    idx[h] = headers.indexOf(h);
  });


  // ---------------------------------------------------
  // RESOURCE IDs
  // ---------------------------------------------------

  var validResources =
    getValidResourceIds_(sourceSS);


  // ---------------------------------------------------
  // VALIDATE QUESTIONS
  // ---------------------------------------------------

  var activeQuestions = [];
  var seenQuestionIds = {};
  var seenQuestionNumbers = {};
  var seenDisplayOrders = {};


  for (var r = 1; r < data.length; r++) {

    var row = data[r];

    var active =
      normalizeBoolean_(row[idx.Active]);

    if (!active) {
      continue;
    }


    var questionId =
      String(row[idx.QuestionID] || '').trim();

    var part =
      String(row[idx.Part] || '').trim().toUpperCase();

    var questionNo =
      Number(row[idx.QuestionNo]);

    var resourceId =
      String(row[idx.ResourceID] || '').trim();

    var questionText =
      String(row[idx.QuestionText] || '').trim();

    var optionA =
      String(row[idx.OptionA] || '').trim();

    var optionB =
      String(row[idx.OptionB] || '').trim();

    var optionC =
      String(row[idx.OptionC] || '').trim();

    var optionD =
      String(row[idx.OptionD] || '').trim();

    var optionE =
      String(row[idx.OptionE] || '').trim();

    var correct =
      String(row[idx.CorrectOption] || '')
        .trim()
        .toUpperCase();

    var marks =
      Number(row[idx.Marks]);

    var displayOrder =
      Number(row[idx.DisplayOrder]);


    // Question ID
    if (!questionId) {

      errors.push(
        'Row ' + (r + 1) +
        ': QuestionID is blank.'
      );

    }


    if (seenQuestionIds[questionId]) {

      errors.push(
        'Duplicate QuestionID: ' +
        questionId
      );

    }

    seenQuestionIds[questionId] = true;


    // Part
    if (
      ['A', 'B', 'C', 'D', 'E']
        .indexOf(part) === -1
    ) {

      errors.push(
        questionId +
        ': Invalid Part "' +
        part +
        '".'
      );

    }


    // Question number
    if (
      !questionNo ||
      questionNo < 1 ||
      questionNo > 40
    ) {

      errors.push(
        questionId +
        ': Invalid QuestionNo.'
      );

    }


    if (seenQuestionNumbers[questionNo]) {

      errors.push(
        'Duplicate QuestionNo: ' +
        questionNo
      );

    }

    seenQuestionNumbers[questionNo] = true;


    // Question text
    if (!questionText) {

      errors.push(
        questionId +
        ': QuestionText is blank.'
      );

    }


    // Options
    if (!optionA) {
      errors.push(questionId + ': Option A missing.');
    }

    if (!optionB) {
      errors.push(questionId + ': Option B missing.');
    }

    if (!optionC) {
      errors.push(questionId + ': Option C missing.');
    }

    if (!optionD) {
      errors.push(questionId + ': Option D missing.');
    }

    if (!optionE) {
      errors.push(questionId + ': Option E missing.');
    }


    // Correct answer
    if (
      ['A', 'B', 'C', 'D', 'E']
        .indexOf(correct) === -1
    ) {

      errors.push(
        questionId +
        ': CorrectOption must be A, B, C, D or E.'
      );

    }


    // Marks
    if (
      isNaN(marks) ||
      marks <= 0
    ) {

      errors.push(
        questionId +
        ': Invalid Marks value.'
      );

    }


    // Display order
    if (
      isNaN(displayOrder) ||
      displayOrder < 1
    ) {

      errors.push(
        questionId +
        ': Invalid DisplayOrder.'
      );

    }


    if (seenDisplayOrders[displayOrder]) {

      errors.push(
        'Duplicate DisplayOrder: ' +
        displayOrder
      );

    }

    seenDisplayOrders[displayOrder] = true;


    // Resource validation
    if (
      resourceId &&
      !validResources[resourceId]
    ) {

      errors.push(
        questionId +
        ': ResourceID "' +
        resourceId +
        '" does not exist.'
      );

    }


    activeQuestions.push(row);

  }


  // ---------------------------------------------------
  // EXPECTED COUNT
  // ---------------------------------------------------

  if (
    activeQuestions.length !==
    PROCTOR_MASTER_CONFIG.EXPECTED_QUESTION_COUNT
  ) {

    errors.push(
      'Expected ' +
      PROCTOR_MASTER_CONFIG.EXPECTED_QUESTION_COUNT +
      ' active questions, but found ' +
      activeQuestions.length +
      '.'
    );

  }


  // ---------------------------------------------------
  // ENSURE Q1-Q40 EXIST
  // ---------------------------------------------------

  for (
    var q = 1;
    q <= PROCTOR_MASTER_CONFIG.EXPECTED_QUESTION_COUNT;
    q++
  ) {

    if (!seenQuestionNumbers[q]) {

      errors.push(
        'Question number missing: Q' + q
      );

    }

  }


  return {

    ok: errors.length === 0,

    errors: errors,

    questionCount:
      activeQuestions.length

  };

}



/**
 * GET VALID RESOURCE IDs
 */
function getValidResourceIds_(sourceSS) {

  var resourceSheet =
    sourceSS.getSheetByName(
      'QUESTION_RESOURCES'
    );

  var data =
    resourceSheet.getDataRange().getValues();

  var result = {};


  if (data.length < 2) {
    return result;
  }


  var headers = data[0];

  var resourceIdx =
    headers.indexOf('ResourceID');


  if (resourceIdx === -1) {

    throw new Error(
      'QUESTION_RESOURCES is missing ResourceID column.'
    );

  }


  for (var r = 1; r < data.length; r++) {

    var id =
      String(
        data[r][resourceIdx] || ''
      ).trim();

    if (id) {
      result[id] = true;
    }

  }


  return result;

}



/**
 * COPY ONE MASTER SHEET TO LIVE SHEET
 */
function copyMasterSheetToLive_(
  sourceSS,
  targetSS,
  sheetName
) {

  var sourceSheet =
    sourceSS.getSheetByName(sheetName);

  if (!sourceSheet) {
    throw new Error(
      'Source sheet not found: ' + sheetName
    );
  }

  var sourceRange =
    sourceSheet.getDataRange();

  var data;

  // QUESTION_BANK contains answer choices where
  // formatting like 10%, $3,300, 11:00 etc. must be preserved.
  if (sheetName === 'QUESTION_BANK') {
    data = sourceRange.getDisplayValues();
  } else {
    data = sourceRange.getValues();
  }

  var targetSheet =
    targetSS.getSheetByName(sheetName);

  if (!targetSheet) {
    targetSheet =
      targetSS.insertSheet(sheetName);
  }

  targetSheet.clearContents();

  if (
    data.length > 0 &&
    data[0].length > 0
  ) {

    if (
      targetSheet.getMaxRows() <
      data.length
    ) {
      targetSheet.insertRowsAfter(
        targetSheet.getMaxRows(),
        data.length -
        targetSheet.getMaxRows()
      );
    }

    if (
      targetSheet.getMaxColumns() <
      data[0].length
    ) {
      targetSheet.insertColumnsAfter(
        targetSheet.getMaxColumns(),
        data[0].length -
        targetSheet.getMaxColumns()
      );
    }

    targetSheet
      .getRange(
        1,
        1,
        data.length,
        data[0].length
      )
      .setValues(data);
  }

  targetSheet.setFrozenRows(1);

  if (
    data.length > 0 &&
    data[0].length > 0
  ) {

    targetSheet
      .getRange(
        1,
        1,
        1,
        data[0].length
      )
      .setFontWeight('bold')
      .setBackground('#1F4E78')
      .setFontColor('#FFFFFF');
  }

  targetSheet
    .getDataRange()
    .setWrap(true);

  Logger.log(
    'Imported: ' +
    sheetName +
    ' (' +
    data.length +
    ' rows)'
  );
}



/**
 * IMPORT AUDIT LOG
 */
function logQuestionImport_(
  ss,
  questionCount,
  status,
  message
) {

  var sheetName =
    'QUESTION_IMPORT_LOG';


  var sh =
    ss.getSheetByName(sheetName);


  if (!sh) {

    sh =
      ss.insertSheet(sheetName);


    sh.appendRow([
      'Imported At',
      'Imported By',
      'Question Count',
      'Status',
      'Message'
    ]);


    sh
      .getRange('A1:E1')
      .setFontWeight('bold')
      .setBackground('#1F4E78')
      .setFontColor('#FFFFFF');

  }


  var userEmail = '';

  try {

    userEmail =
      Session
        .getActiveUser()
        .getEmail();

  } catch (e) {
    userEmail = '';
  }


  sh.appendRow([
    new Date(),
    userEmail,
    questionCount,
    status,
    message
  ]);

}



/**
 * NORMALIZE TRUE / FALSE
 */
function normalizeBoolean_(value) {

  if (value === true) {
    return true;
  }


  var s =
    String(value || '')
      .trim()
      .toLowerCase();


  return (
    s === 'true' ||
    s === 'yes' ||
    s === '1'
  );

}

function onOpen() {

  SpreadsheetApp
    .getUi()
    .createMenu('Proctor Exam Admin')
    .addItem(
      'Import / Refresh Question Bank',
      'importQuestionBankFromMaster'
    )
    .addToUi();

}

