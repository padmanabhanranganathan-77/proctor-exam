PROCTOR EXAM v5.1 - SAFE SUBMISSION FIX

1) Apps Script:
   Replace current Code.gs with Code.gs from this folder.
   Save, then Deploy > Manage deployments > Edit > New version > Deploy.

2) GitHub:
   Replace ONLY app.js in the proctor-exam repository.
   index.html and style.css do not need changes for this fix.

What changed:
- Final submit timeout increased to 120 seconds.
- Browser checks backend status after a delayed/timeout response.
- Repeated Submit clicks are blocked while submission is in progress.
- Backend final submission is idempotent.
- Bulk answer saving avoids re-reading sheets once per answer.
- Session fields are updated in one sheet write instead of one write per field.
- New getSubmissionStatus RPC supports safe recovery.
