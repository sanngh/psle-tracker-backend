# PSLE Prep Tracker

An offline-first React Native and Node.js application for tracking PSLE syllabus mastery, parent-assigned exam papers, parent-driven revision, feedback, timers, alerts, and mistake evidence.

## Project Structure

```text
psle-tracker-offline/
|-- backend/
|   |-- server.js
|   |-- syllabus.json
|   |-- exams_bank.json
|   |-- revision.json
|   |-- package.json
|   |-- psle_tracker.db       # Created at runtime
|   `-- uploads/               # Created photo storage
|-- frontend/
|   |-- App.js
|   |-- components/
|   |-- context/
|   |-- hooks/
|   |-- screens/
|   |-- utils/
|   `-- package.json
`-- checkpoints/
```

## Requirements

- Node.js and npm
- Expo CLI or an Expo-compatible mobile development environment
- A phone or emulator connected to the same network as the backend when using a physical device

## Recent Changes and Product Updates

### 1) Upload limit fix
The backend was previously failing when a size like `25mb` was treated as a raw integer instead of a byte value. This caused `MulterError: File too large` and upload parsing problems. The fix adds robust human-readable byte parsing so values like `25mb`, `500kb`, and `100mb` are converted correctly before file upload validation.

### 2) Environment-based configuration
The app now loads a base `.env` file first and then overlays the active environment file (`.env.dev` or `.env.prod`) so defaults are always present and environment-specific overrides are applied cleanly.

The server can also switch between SQLite and Turso by checking a `USE_SQLITE` flag. In local development, SQLite is the default. In production, you can disable SQLite and point the app to Turso values.

### 3) Parent/student role model and precedence rule
Users now store a `role` value (`parent` or `student`). When the same phone number is registered again with a conflicting role, the system resolves it consistently and keeps the user as `parent` if either the existing or incoming role is `parent`.

This prevents duplicate conflicting identities from being created for the same mobile number.

### 4) Parent-child relationship linking
A dedicated `user_links` table was added so a parent can be linked to a student account. This is the foundation for: 
- parent tracking student activity
- student records being viewable from the parent dashboard
- safe linkage without creating separate conflicting user records

### 5) Custom practice content support
Parents can now add custom prelim papers and revision items per subject. These remain tied to the relevant user and can be assigned and tracked separately from the built-in bank items.

### 6) Photo storage hardening
Photo uploads are stored using a hashed phone number and month folder structure, which prevents collisions and keeps files access-controlled by user identity. Retrieval is also tied to the parent/student linkage flow.

## Installation

Install backend dependencies:

```powershell
cd backend
npm install
```

Install frontend dependencies:

```powershell
cd frontend
npm install
```

## Running the Application

Start the backend first:

```powershell
cd backend
npm start
```

The backend listens on port `3000`.

Start the Expo frontend in another terminal:

```powershell
cd frontend
npm start
```

The API address is configured in `frontend/context/AppContext.js` through `API_URL`. Update the local network address when the backend device IP changes.

## First-Time Login

1. Enter a valid Singapore mobile number.
2. The app checks whether the account exists.
3. New users see **Syllabus Core Activation**.
4. Expand each subject section.
5. Select or unselect syllabus topics.
6. Select **Activate Core & Open Dashboard**.

The selected syllabus topics are stored for the user in SQLite.

## Student Features

### Syllabus Tracker

Students can open the syllabus panel and update each topic to:

- 0%
- 25%
- 50%
- 75%
- 100%

Updates are saved to `subject_hub` and appear in the parent syllabus panel.

### Parent-Driven Revision

From June onward, students can see revision topics selected by a parent. Each revision topic opens a simulator with:

- Start and pause timer
- Reset timer
- Progress controls from 0% to 100%
- Persistent elapsed time
- A 90-minute maximum-time display for every revision topic
- A 90-minute maximum-time display for every prelim paper
- A visible time-exceeded indicator when the limit is passed

A topic at 100% is removed from the student active list and remains completed in the parent view.

### Assigned Exam Papers

Parents assign exam papers from the exam bank. Students can open an assigned paper in the testing simulator with:

- Start and pause timer
- Reset timer
- Scored and total fields
- Completion submission
- Persistent elapsed time

## Parent Features

### Exam Paper Assignment

**Assign Prelims Exam Papers** opens a panel containing exam-bank papers grouped by subject. Unassigned papers can be unlocked for the student. The panel shows pending, active, and completed states.

### Revision Topic Assignment

**Assign Revision Topics** opens a panel containing syllabus-based topics from `backend/revision.json`. Parents can select topics by subject and monitor progress.

### Syllabus Topics Progress

**View Syllabus Topics Track** opens a read-only panel showing each syllabus topic and its current completion percentage.

### Subject Topic Coverage

**View Subject Analytics** displays three subject rows:

- Science
- Mathematics
- English

Each subject has two separate bars:

- Syllabus Topics: teal bar showing topics with progress above 0%
- Revision Topics: orange bar showing topics with progress above 0%

The display includes covered and total topic counts. It does not use feedback scores.

### Metrics and Charts

The feedback drawer includes a Metrics & Charts view. Its performance chart averages all valid School, Tuition, and Self marks for each subject and month. Student-entered marks are displayed separately in amber under **Child's Self-Reflections**.

### Alerts

Parents receive alerts for:

- Completed syllabus topics
- Completed exam papers
- Revision milestones at 25%, 50%, 75%, and 100%

Completing an exam paper resets its alert state, so the parent receives a fresh completion alert even if an earlier alert for that paper had been dismissed.

Alerts can be dismissed individually or with **Dismiss All Alerts**. Revision milestone dismissal tracks the highest dismissed percentage, allowing later milestones to raise new alerts.

### Mistakes Error Log

Parent mistake rows are grouped by keyword and display an occurrence count. Expanding a row shows:

- Individual descriptions
- Uploaded images
- The description belonging to each image

## Double-Gate Verification

The app prevents false completion claims:

- A revision topic cannot be marked 100% without at least one linked Mistakes Log entry.
- An exam paper cannot be completed without at least one linked Mistakes Log entry.
- The student receives a verification warning when evidence is missing.

When a student opens a revision topic or exam paper, it becomes the active evidence target. The next text or photo mistake entry is linked to that target.

The student mistake logger provides an explicit **Link Evidence To** dropdown listing assigned exams and active revisions. The student must choose the target before saving a photo, allowing a picture taken at any time to be linked deliberately.

## Mistake Photo Storage

Uploaded photos are stored by hashed user phone and upload month:

```text
backend/uploads/<sha256-phone>/<YYYY-MM>/<generated-filename>
```

Each upload is recorded in the `uploaded_files` table with:

- Mistake ID
- Hashed parent phone
- Month folder
- Relative path
- Original filename
- Upload timestamp
- User phone

Parent retrieval uses the phone hash and linked mistake ID. Existing legacy flat-path photo URLs remain supported as a fallback.

## Backend Data

The SQLite database is created automatically as `backend/psle_tracker.db`.

Main tables:

- `users`: registered phone numbers
- `subject_hub`: syllabus topics and progress
- `exam_tracker`: exam papers, assignment state, scores, and timer seconds
- `revision_tracker`: revision topics, assignment state, progress, alerts, and timer seconds
- `mistakes_log`: grouped keywords, descriptions, linked evidence, and legacy photo URLs
- `uploaded_files`: structured photo metadata
- `teacher_feedback`: School, Tuition, and Self feedback marks

`revision.json` is the source for revision topics. It mirrors the topic structure in `syllabus.json` and is separate from `exams_bank.json`.

## API Summary

### Authentication and Dashboard

- `POST /api/auth/check`
- `POST /api/auth/onboard`
- `POST /api/dashboard`
- `GET /api/syllabus`

### Syllabus

- `POST /api/syllabus/update-progress`
- `POST /api/syllabus/dismiss-alert`

### Exams

- `POST /api/exams/assign`
- `POST /api/exams/update`
- `POST /api/exams/update-timer`
- `POST /api/exams/dismiss-alert`

### Revisions

- `POST /api/revisions/assign`
- `POST /api/revisions/update-progress`
- `POST /api/revisions/update-timer`
- `POST /api/revisions/dismiss-alert`

### Alerts and Feedback

- `POST /api/alerts/dismiss-all`
- `POST /api/feedback/save`

### Mistakes and Uploads

- `POST /api/errors/log-text`
- `POST /api/errors/log-with-photo`
- Static photos: `/uploads/<hash>/<month>/<filename>`

## Resetting Local Data

Stop the backend before deleting the database because the running Node process locks the file.

```powershell
cd backend
Remove-Item .\psle_tracker.db -Force
Get-ChildItem .\uploads -Force | Remove-Item -Recurse -Force
npm start
```

This removes all accounts, progress, assignments, feedback, alerts, mistake records, timers, and uploaded photos. The database tables are recreated automatically when the backend starts.

## Checkpoints

The repository may contain dated ZIP checkpoints under `checkpoints/`. These contain source and configuration files but exclude dependencies, runtime database data, and uploaded photos.

## Troubleshooting

### Backend connection errors

- Confirm the backend is running on port `3000`.
- Confirm the `API_URL` address is reachable from the phone or emulator.
- Ensure both devices are on the same network.

### New database columns not appearing

Stop and restart the backend. The startup migration statements add columns to existing SQLite tables.

### Photos not visible in the parent view

- Confirm the backend is running.
- Confirm the photo upload request includes a keyword and description.
- Confirm the generated URL is reachable from the parent device.
- Confirm `backend/uploads` exists and contains the hashed phone/month path.

## Documentation Maintenance Rule

Whenever code changes affect features, user flows, API routes, database columns, storage paths, setup commands, or visible labels, update this README in the same change. Keep the feature descriptions and API summary aligned with the implementation.

## Current Validation

The main frontend and backend files are checked with VS Code diagnostics after changes. No automated test suite is currently configured in the project.
