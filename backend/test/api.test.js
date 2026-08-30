const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, after, test } = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'psle-tracker-test-'));
const databasePath = path.join(testRoot, 'test.db');
const uploadsPath = path.join(testRoot, 'uploads');
const port = 3127;
const baseUrl = `http://127.0.0.1:${port}/api`;
const userKey = '91234567';

process.env.DB_PATH = databasePath;
process.env.UPLOADS_DIR = uploadsPath;
process.env.PORT = String(port);
process.env.USE_SQLITE = 'true';
process.env.DATABASE_PROVIDER = 'sqlite';
process.env.MEDIA_STORAGE_PROVIDER = 'local';
process.env.REQUIRE_EVIDENCE_LINKING = 'true';
process.env.ADMIN_TOKEN = 'test-owner-token';
process.env.RATE_LIMIT_MAX_REQUESTS = '1000';

const config = require('../config');
const { app, db } = require('../server');
const { createMediaStorage } = require('../mediaStorage');
let server;

async function request(endpoint, options) {
  return fetch(`${baseUrl}${endpoint}`, options);
}

async function jsonRequest(endpoint, body) {
  return request(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

const testDisclaimer = {
  title: 'Test confidentiality notice',
  version: 'test-1.0',
  introduction: 'Test notice text.',
  sectionTitle: 'Terms',
  terms: ['Test term'],
  checkboxLabel: 'I agree.'
};

before(async () => {
  server = await new Promise(resolve => {
    const listener = app.listen(port, () => resolve(listener));
  });
  await new Promise(resolve => setTimeout(resolve, 100));
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => db.close(resolve));
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('upload limits parse human-readable sizes correctly', () => {
  assert.equal(config.parseByteSize('25mb'), 25 * 1024 * 1024);
  assert.equal(config.parseByteSize('500kb'), 500 * 1024);
  assert.equal(config.parseByteSize('2gb'), 2 * 1024 * 1024 * 1024);
  assert.equal(config.parseByteSize('not-a-size'), 100 * 1024 * 1024);
});

test('cloud providers require their account settings only when selected', () => {
  assert.deepEqual(config.validateCloudProviderSettings({ databaseProvider: 'sqlite', mediaStorageProvider: 'local' }), []);

  const tursoErrors = config.validateCloudProviderSettings({ databaseProvider: 'turso', mediaStorageProvider: 'local' });
  assert.match(tursoErrors[0], /TURSO_DATABASE_URL, TURSO_AUTH_TOKEN/);

  const r2Errors = config.validateCloudProviderSettings({ databaseProvider: 'sqlite', mediaStorageProvider: 'r2' });
  assert.match(r2Errors[0], /R2_ACCOUNT_ID/);
  assert.match(r2Errors[0], /R2_PUBLIC_BASE_URL/);
});

test('local media provider writes files and builds upload URLs', async () => {
  const mediaStorage = createMediaStorage({ mediaStorageProvider: 'local', uploadsDir: uploadsPath });
  const objectKey = 'account/2026-08/evidence.jpg';
  await mediaStorage.putObject({ objectKey, buffer: Buffer.from('evidence') });

  assert.equal(fs.readFileSync(path.join(uploadsPath, 'account', '2026-08', 'evidence.jpg'), 'utf8'), 'evidence');
  assert.equal(mediaStorage.getPublicUrl(objectKey, 'http://localhost:3000'), 'http://localhost:3000/uploads/account/2026-08/evidence.jpg');
});

test('owner table browser requires the admin token and returns read-only table data', async () => {
  const unauthorized = await request('/admin/tables');
  assert.equal(unauthorized.status, 401);

  const tablesResponse = await request('/admin/tables', { headers: { 'x-admin-token': 'test-owner-token' } });
  assert.equal(tablesResponse.status, 200);
  const tables = await tablesResponse.json();
  assert.ok(tables.includes('users'));
  assert.ok(tables.includes('consent_life'));
  assert.ok(tables.includes('consent_record'));
  assert.ok(!tables.some(table => table.startsWith('sqlite_')));

  const usersResponse = await request('/admin/tables/users', { headers: { 'x-admin-token': 'test-owner-token' } });
  assert.equal(usersResponse.status, 200);
  const usersData = await usersResponse.json();
  assert.equal(usersData.table, 'users');
  assert.ok(usersData.columns.some(column => column.name === 'phone'));
  assert.ok(usersData.columns.some(column => column.name === 'user_id'));
  assert.ok(Array.isArray(usersData.rows));

  const missingTableResponse = await request('/admin/tables/not_a_real_table', { headers: { 'x-admin-token': 'test-owner-token' } });
  assert.equal(missingTableResponse.status, 404);

  const invalidNameResponse = await request('/admin/tables/not-a-real-table', { headers: { 'x-admin-token': 'test-owner-token' } });
  assert.equal(invalidNameResponse.status, 400);
});

test('owner can block and unblock a user, and blocked users cannot authenticate', async () => {
  const blockedUser = '7000000099';
  const registration = await jsonRequest('/auth/onboard', {
    userKey: blockedUser,
    selectedTopics: [{ name: 'Blockable user topic', subject: 'Science', level: 'P6' }],
    role: 'student'
  });
  assert.equal(registration.status, 200);

  const unauthorizedBlock = await request(`/admin/users/${blockedUser}/block`, { method: 'POST' });
  assert.equal(unauthorizedBlock.status, 401);

  const block = await request(`/admin/users/${blockedUser}/block`, { method: 'POST', headers: { 'x-admin-token': 'test-owner-token' } });
  assert.equal(block.status, 200);

  const blockedCheck = await jsonRequest('/auth/check', { userKey: blockedUser });
  assert.equal(blockedCheck.status, 403);

  const usersResponse = await request('/admin/users', { headers: { 'x-admin-token': 'test-owner-token' } });
  const users = await usersResponse.json();
  assert.equal(Number(users.find(user => user.phone === blockedUser).blocked), 1);

  const unblock = await request(`/admin/users/${blockedUser}/unblock`, { method: 'POST', headers: { 'x-admin-token': 'test-owner-token' } });
  assert.equal(unblock.status, 200);
  const unblockedCheck = await jsonRequest('/auth/check', { userKey: blockedUser });
  assert.equal(unblockedCheck.status, 200);
  assert.equal((await unblockedCheck.json()).exists, true);
});

test('records login, heartbeat, session end, and total duration', async () => {
  const sessionUser = '7000000088';
  const registration = await jsonRequest('/auth/onboard', {
    userKey: sessionUser,
    selectedTopics: [{ name: 'Session tracking topic', subject: 'Science', level: 'P6' }],
    role: 'student'
  });
  assert.equal(registration.status, 200);

  const startResponse = await jsonRequest('/sessions/start', { userKey: sessionUser, role: 'student' });
  assert.equal(startResponse.status, 200);
  const started = await startResponse.json();
  assert.match(started.sessionId, /^[0-9a-f-]{36}$/i);

  const heartbeat = await jsonRequest('/sessions/heartbeat', { userKey: sessionUser, sessionId: started.sessionId });
  assert.equal(heartbeat.status, 200);

  await new Promise((resolve, reject) => {
    db.run("UPDATE user_sessions SET logged_in_at = datetime('now', '-2 minutes') WHERE session_id = ?", [started.sessionId], error => error ? reject(error) : resolve());
  });

  const endResponse = await jsonRequest('/sessions/end', { userKey: sessionUser, sessionId: started.sessionId, reason: 'test_end' });
  assert.equal(endResponse.status, 200);
  const ended = await endResponse.json();
  assert.ok(ended.durationSeconds >= 119);

  const storedSession = await new Promise((resolve, reject) => {
    db.get('SELECT role, logged_in_at, last_seen_at, ended_at, duration_seconds, end_reason FROM user_sessions WHERE session_id = ?', [started.sessionId], (error, row) => error ? reject(error) : resolve(row));
  });
  assert.equal(storedSession.role, 'student');
  assert.ok(storedSession.logged_in_at);
  assert.ok(storedSession.last_seen_at);
  assert.ok(storedSession.ended_at);
  assert.ok(Number(storedSession.duration_seconds) >= 119);
  assert.equal(storedSession.end_reason, 'test_end');
});

test('a student stays locked until their linked parent accepts consent', async () => {
  const parentPhone = '7660001111';
  const studentPhone = '7660002222';

  const unlinkedStatus = await jsonRequest('/consent/child-status', { userPhone: studentPhone });
  assert.equal(unlinkedStatus.status, 200);
  const unlinkedResult = await unlinkedStatus.json();
  assert.equal(unlinkedResult.unlocked, false);
  assert.equal(unlinkedResult.linked, false);

  await jsonRequest('/auth/onboard', {
    userKey: parentPhone,
    role: 'parent',
    studentUserKey: studentPhone,
    selectedTopics: [{ name: 'Child lock parent topic', subject: 'Science', level: 'P6' }]
  });

  const linkedNoConsentStatus = await jsonRequest('/consent/child-status', { userPhone: studentPhone });
  const linkedNoConsentResult = await linkedNoConsentStatus.json();
  assert.equal(linkedNoConsentResult.linked, true);
  assert.equal(linkedNoConsentResult.unlocked, false);
  assert.equal(linkedNoConsentResult.parentPhone, parentPhone);

  const parentConsent = await jsonRequest('/consent', { userPhone: parentPhone, role: 'parent', disclaimer: testDisclaimer });
  assert.equal(parentConsent.status, 200);

  const unlockedStatus = await jsonRequest('/consent/child-status', { userPhone: studentPhone });
  const unlockedResult = await unlockedStatus.json();
  assert.equal(unlockedResult.unlocked, true);
  assert.equal(unlockedResult.parentConsented, true);
});

test('records consent for both parent and student and protects owner export', async () => {
  const parentConsent = await jsonRequest('/consent', { userPhone: '7000000001', role: 'parent', disclaimer: testDisclaimer });
  assert.equal(parentConsent.status, 200);
  const parentResult = await parentConsent.json();
  assert.equal(parentResult.disclaimerVersion, 'test-1.0');
  assert.match(parentResult.disclaimerHash, /^[a-f0-9]{64}$/);

  const studentConsent = await jsonRequest('/consent', { userPhone: '7000000002', role: 'student', disclaimer: testDisclaimer });
  assert.equal(studentConsent.status, 200);

  const unauthorizedExport = await request('/admin/consents');
  assert.equal(unauthorizedExport.status, 401);

  const ownerExport = await request('/admin/consents', { headers: { 'x-admin-token': 'test-owner-token' } });
  assert.equal(ownerExport.status, 200);
  const records = await ownerExport.json();
  assert.ok(records.some(record => record.user_phone === '7000000001' && record.role === 'parent'));
  assert.ok(records.some(record => record.user_phone === '7000000002' && record.role === 'student'));
});

test('consent recording is idempotent per user and disclaimer version', async () => {
  const first = await jsonRequest('/consent', { userPhone: '7000000003', role: 'student', disclaimer: testDisclaimer });
  assert.equal(first.status, 200);
  const second = await jsonRequest('/consent', { userPhone: '7000000003', role: 'student', disclaimer: testDisclaimer });
  assert.equal(second.status, 200);

  const ownerExport = await request('/admin/consents', { headers: { 'x-admin-token': 'test-owner-token' } });
  const records = (await ownerExport.json()).filter(record => record.user_phone === '7000000003' && record.disclaimer_version === 'test-1.0');
  assert.equal(records.length, 1);
});

test('same phone resolves to parent precedence when re-registered with a conflicting role', async () => {
  const secondUserKey = '9995550001';

  const parentRegistration = await jsonRequest('/auth/onboard', {
    userKey: secondUserKey,
    selectedTopics: [{ name: 'Parent onboarding', subject: 'Mathematics', level: 'P6' }],
    role: 'parent',
    studentUserKey: '9995550002'
  });
  assert.equal(parentRegistration.status, 200);

  const childRegistration = await jsonRequest('/auth/onboard', {
    userKey: secondUserKey,
    selectedTopics: [{ name: 'Student onboarding', subject: 'Mathematics', level: 'P6' }],
    role: 'student'
  });
  assert.equal(childRegistration.status, 200);

  const storedUser = await new Promise((resolve, reject) => {
    db.get('SELECT role FROM users WHERE phone = ?', [secondUserKey], (err, row) => err ? reject(err) : resolve(row));
  });

  assert.equal(storedUser.role, 'parent');
});

test('parent can explicitly link a student after the student already registered', async () => {
  const parentPhone = '7775550001';
  const studentPhone = '7775550002';

  const studentRegistration = await jsonRequest('/auth/onboard', {
    userKey: studentPhone,
    selectedTopics: [{ name: 'Linked student onboarding', subject: 'Mathematics', level: 'P6' }],
    role: 'student',
    parentUserKey: parentPhone
  });
  assert.equal(studentRegistration.status, 200);

  const linkResponse = await jsonRequest('/links/create', {
    parentUserKey: parentPhone,
    studentUserKey: studentPhone
  });
  assert.equal(linkResponse.status, 200);

  const childrenResponse = await jsonRequest('/links/children', { userKey: parentPhone });
  assert.equal(childrenResponse.status, 200);
  const linkedChildren = await childrenResponse.json();
  assert.ok(linkedChildren.some(child => child.student_phone === studentPhone));
  assert.ok(linkedChildren.some(child => /^family-\d+$/.test(child.user_key)));
});

test('parent-first link remains after the student onboards later', async () => {
  const parentPhone = '7775550011';
  const studentPhone = '7775550012';
  const parentRegistration = await jsonRequest('/auth/onboard', {
    userKey: parentPhone,
    selectedTopics: [{ name: 'Parent-first link parent', subject: 'Science', level: 'P6' }],
    role: 'parent',
    studentUserKey: studentPhone
  });
  assert.equal(parentRegistration.status, 200);

  const linkResponse = await jsonRequest('/links/create', {
    parentUserKey: parentPhone,
    studentUserKey: studentPhone
  });
  assert.equal(linkResponse.status, 200);

  const studentRegistration = await jsonRequest('/auth/onboard', {
    userKey: studentPhone,
    selectedTopics: [{ name: 'Parent-first link student', subject: 'Science', level: 'P6' }],
    role: 'student'
  });
  assert.equal(studentRegistration.status, 200);

  const parentLinkResponse = await jsonRequest('/links/parent', { userKey: studentPhone });
  assert.equal(parentLinkResponse.status, 200);
  const parentLinks = await parentLinkResponse.json();
  assert.ok(parentLinks.some(link => link.parent_phone === parentPhone && link.student_phone === studentPhone));
});

test('parent onboarding can create and link a student in one request', async () => {
  const parentPhone = '7775550031';
  const studentPhone = '7775550032';

  const onboarding = await jsonRequest('/auth/onboard', {
    userKey: parentPhone,
    role: 'parent',
    studentUserKey: studentPhone,
    selectedTopics: [{ name: 'Combined onboarding topic', subject: 'Science', level: 'P6' }]
  });
  assert.equal(onboarding.status, 200);

  const parentLinks = await jsonRequest('/links/children', { userKey: parentPhone });
  assert.equal(parentLinks.status, 200);
  const links = await parentLinks.json();
  assert.ok(links.some(link => link.student_phone === studentPhone && /^family-\d+$/.test(link.user_key)));

  const studentDashboard = await jsonRequest('/dashboard', { userKey: studentPhone, profileType: 'student' });
  assert.equal(studentDashboard.status, 200);
  const studentData = await studentDashboard.json();
  assert.equal(studentData.exams.length, 0, 'unassigned prelims are hidden from the student dashboard');
  assert.equal(studentData.revisionTopics.length, 0, 'unassigned revisions are hidden from the student dashboard');
  const seededRows = await new Promise((resolve, reject) => {
    db.get('SELECT user_key FROM user_links WHERE parent_phone = ? AND student_phone = ?', [parentPhone, studentPhone], (linkError, link) => {
      if (linkError) return reject(linkError);
      db.get('SELECT (SELECT COUNT(*) FROM exam_tracker WHERE user_key = ?) AS exams, (SELECT COUNT(*) FROM revision_tracker WHERE user_key = ?) AS revisions', [link.user_key, link.user_key], (error, row) => error ? reject(error) : resolve(row));
    });
  });
  assert.ok(Number(seededRows.exams) > 0);
  assert.ok(Number(seededRows.revisions) > 0);
});

test('parent onboarding requires a student phone number', async () => {
  const response = await jsonRequest('/auth/onboard', {
    userKey: '7775550041',
    role: 'parent',
    selectedTopics: [{ name: 'Parent requires student', subject: 'Science', level: 'P6' }]
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /student phone number is required/i);
});

test('linked phones resolve to parent and student roles from the relationship', async () => {
  const parentPhone = '7775550021';
  const studentPhone = '7775550022';

  await jsonRequest('/auth/onboard', {
    userKey: parentPhone,
    selectedTopics: [{ name: 'Role link parent', subject: 'Science', level: 'P6' }],
    role: 'parent'
  });
  await jsonRequest('/links/create', { parentUserKey: parentPhone, studentUserKey: studentPhone });

  const parentCheck = await jsonRequest('/auth/check', { userKey: parentPhone });
  assert.equal(parentCheck.status, 200);
  assert.equal((await parentCheck.json()).role, 'parent');

  const studentCheck = await jsonRequest('/auth/check', { userKey: studentPhone });
  assert.equal(studentCheck.status, 200);
  assert.equal((await studentCheck.json()).role, 'student');
});

test('authentication and syllabus onboarding create dashboard data', async () => {
  const syllabusResponse = await request('/syllabus');
  assert.equal(syllabusResponse.status, 200);
  const syllabus = await syllabusResponse.json();
  assert.equal(syllabus.length, 31);

  const checkResponse = await jsonRequest('/auth/check', { userKey });
  assert.equal(checkResponse.status, 200);
  assert.equal((await checkResponse.json()).exists, false);

  const onboardResponse = await jsonRequest('/auth/onboard', {
    userKey,
    selectedTopics: [syllabus[0]]
  });
  assert.equal(onboardResponse.status, 200);

  const studentDashboard = await jsonRequest('/dashboard', { userKey, profileType: 'student' });
  assert.equal(studentDashboard.status, 200);
  const studentData = await studentDashboard.json();
  assert.equal(studentData.syllabusProgress.length, 1);
  assert.equal(studentData.exams.length, 0);
  assert.equal(studentData.revisionTopics.length, 0);
});

test('student can save confidence when completing a syllabus topic', async () => {
  const studentKey = '91234568';
  const onboarding = await jsonRequest('/auth/onboard', {
    userKey: studentKey,
    selectedTopics: [{ name: 'Confidence completion topic', subject: 'Science', level: 'P6' }],
    role: 'student'
  });
  assert.equal(onboarding.status, 200);

  const dashboard = await jsonRequest('/dashboard', { userKey: studentKey, profileType: 'student' });
  const topic = (await dashboard.json()).syllabusProgress[0];
  const completion = await jsonRequest('/syllabus/update-progress', {
    id: topic.id,
    progress: 100,
    confidence: 'Very Good',
    userKey: studentKey
  });
  assert.equal(completion.status, 200);

  const updatedDashboard = await jsonRequest('/dashboard', { userKey: studentKey, profileType: 'student' });
  const updatedTopic = (await updatedDashboard.json()).syllabusProgress.find(row => row.id === topic.id);
  assert.equal(updatedTopic.progress, 100);
  assert.equal(updatedTopic.confidence, 'Very Good');
  assert.ok((await jsonRequest('/dashboard', { userKey: studentKey, profileType: 'parent' })).status === 200);

  const invalid = await jsonRequest('/syllabus/update-progress', {
    id: topic.id,
    progress: 100,
    confidence: 'Excellent',
    userKey: studentKey
  });
  assert.equal(invalid.status, 400);
});

test('linked parent receives a syllabus completion alert', async () => {
  const parentPhone = '7880003311';
  const studentPhone = '7880003322';
  await jsonRequest('/auth/onboard', {
    userKey: parentPhone,
    role: 'parent',
    studentUserKey: studentPhone,
    selectedTopics: [{ name: 'Linked syllabus alert parent', subject: 'Science', level: 'P6' }]
  });

  const studentDashboard = await jsonRequest('/dashboard', { userKey: studentPhone, profileType: 'student' });
  const topic = (await studentDashboard.json()).syllabusProgress[0];
  assert.ok(topic);

  const completion = await jsonRequest('/syllabus/update-progress', {
    id: topic.id,
    progress: 100,
    confidence: 'High',
    userKey: studentPhone
  });
  assert.equal(completion.status, 200);

  const parentDashboard = await jsonRequest('/dashboard', { userKey: parentPhone, profileType: 'parent' });
  const parentData = await parentDashboard.json();
  assert.ok(parentData.alerts.some(alert => alert.type === 'syllabus' && alert.message.includes('Linked syllabus alert parent') && alert.message.includes('confidence: High')));
});

test('linked parent receives a syllabus 75 percent alert with confidence', async () => {
  const parentPhone = '7880004411';
  const studentPhone = '7880004422';
  const onboarding = await jsonRequest('/auth/onboard', {
    userKey: parentPhone,
    role: 'parent',
    studentUserKey: studentPhone,
    selectedTopics: [{ name: 'Linked syllabus 75 topic', subject: 'Science', level: 'P6' }]
  });
  assert.equal(onboarding.status, 200);

  const studentDashboard = await jsonRequest('/dashboard', { userKey: studentPhone, profileType: 'student' });
  const topic = (await studentDashboard.json()).syllabusProgress[0];
  const completion = await jsonRequest('/syllabus/update-progress', {
    id: topic.id,
    progress: 75,
    confidence: 'Good',
    userKey: studentPhone
  });
  assert.equal(completion.status, 200);

  const parentDashboard = await jsonRequest('/dashboard', { userKey: parentPhone, profileType: 'parent' });
  const parentData = await parentDashboard.json();
  assert.ok(parentData.alerts.some(alert => alert.type === 'syllabus' && alert.message.includes('75%') && alert.message.includes('confidence: Good')));
});

test('parent dashboard includes default revision bank before assignment', async () => {
  const parentUserKey = '71234567';
  const studentUserKey = '81234567';
  const onboarding = await jsonRequest('/auth/onboard', {
    userKey: studentUserKey,
    selectedTopics: [{ name: 'Default revision visibility', subject: 'Science', level: 'P6' }],
    role: 'student'
  });
  assert.equal(onboarding.status, 200);
  assert.equal((await jsonRequest('/links/create', { parentUserKey, studentUserKey })).status, 200);

  const dashboard = await jsonRequest('/dashboard', { userKey: parentUserKey, profileType: 'parent' });
  assert.equal(dashboard.status, 200);
  const parentData = await dashboard.json();
  assert.ok(parentData.revisionTopics.length > 0, 'default revision bank should load for parent before assignment');
  assert.ok(parentData.revisionTopics.every(topic => Number(topic.assigned) === 0));
});

test('parent dashboard includes default prelim paper bank before assignment', async () => {
  const parentUserKey = '71234568';
  const studentUserKey = '81234568';
  const onboarding = await jsonRequest('/auth/onboard', {
    userKey: studentUserKey,
    selectedTopics: [{ name: 'Default exam visibility', subject: 'Science', level: 'P6' }],
    role: 'student'
  });
  assert.equal(onboarding.status, 200);
  assert.equal((await jsonRequest('/links/create', { parentUserKey, studentUserKey })).status, 200);

  const dashboard = await jsonRequest('/dashboard', { userKey: parentUserKey, profileType: 'parent' });
  assert.equal(dashboard.status, 200);
  const parentData = await dashboard.json();
  assert.ok(parentData.exams.length > 0, 'default prelim bank should load for parent before assignment');
  assert.ok(parentData.exams.every(exam => Number(exam.assigned) === 0));
});

test('parent assigns revision and student progress raises dismissible milestone alerts', async () => {
  const parentUserKey = '71234569';
  assert.equal((await jsonRequest('/links/create', { parentUserKey, studentUserKey: userKey })).status, 200);
  const parentDashboard = await jsonRequest('/dashboard', { userKey: parentUserKey, profileType: 'parent' });
  const parentData = await parentDashboard.json();
  const revision = parentData.revisionTopics[0];
  assert.equal(revision.max_time_minutes, 90);

  const assignResponse = await jsonRequest('/revisions/assign', { id: revision.id, userKey: parentUserKey });
  assert.equal(assignResponse.status, 200);

  const studentDashboard = await jsonRequest('/dashboard', { userKey, profileType: 'student' });
  const studentData = await studentDashboard.json();
  const assignedRevision = studentData.revisionTopics[0];
  assert.equal(assignedRevision.assigned, 1);
  assert.ok(studentData.revisionTopics.some(topic => topic.id === assignedRevision.id), 'assigned revision should remain in the Parent-Driven Revision grid');
  assert.ok(!studentData.alerts.some(alert => alert.type === 'revision'), 'student should not receive a revision assignment alert');

  const progressResponse = await jsonRequest('/revisions/update-progress', {
    id: assignedRevision.id,
    progress: 25,
    elapsedSeconds: 42,
    userKey
  });
  assert.equal(progressResponse.status, 200);

  const alertDashboard = await jsonRequest('/dashboard', { userKey: parentUserKey, profileType: 'parent' });
  const alertData = await alertDashboard.json();
  assert.ok(alertData.alerts.some(alert => alert.type === 'revision' && alert.message.includes('25%')), JSON.stringify(alertData.alerts));

  const dismissResponse = await jsonRequest('/revisions/dismiss-alert', { id: revision.id, userKey: parentUserKey });
  assert.equal(dismissResponse.status, 200);

  const nextProgressResponse = await jsonRequest('/revisions/update-progress', {
    id: revision.id,
    progress: 50,
    elapsedSeconds: 84,
    userKey
  });
  assert.equal(nextProgressResponse.status, 200);

  const nextAlertDashboard = await jsonRequest('/dashboard', { userKey: parentUserKey, profileType: 'parent' });
  const nextAlertData = await nextAlertDashboard.json();
  assert.match(nextAlertData.alerts.find(alert => alert.type === 'revision').message, /50%/);

  const blockedCompletion = await jsonRequest('/revisions/update-progress', {
    id: revision.id,
    progress: 100,
    elapsedSeconds: 100,
    userKey
  });
  assert.equal(blockedCompletion.status, 409);
});

test('linked mistake evidence unlocks revision and exam completion', async () => {
  const parentUserKey = '71234570';
  assert.equal((await jsonRequest('/links/create', { parentUserKey, studentUserKey: userKey })).status, 200);
  const revisionDashboard = await jsonRequest('/dashboard', { userKey: parentUserKey, profileType: 'parent' });
  const revision = (await revisionDashboard.json()).revisionTopics[0];

  const evidenceResponse = await jsonRequest('/errors/log-text', {
    userKey,
    title: 'Silly mistake',
    description: 'Forgot the unit conversion.',
    category: 'General',
    revisionId: revision.id
  });
  assert.equal(evidenceResponse.status, 200);

  const revisionCompletion = await jsonRequest('/revisions/update-progress', {
    id: revision.id,
    progress: 100,
    elapsedSeconds: 120,
    userKey
  });
  assert.equal(revisionCompletion.status, 200);

  const examsDashboard = await jsonRequest('/dashboard', { userKey: parentUserKey, profileType: 'parent' });
  const exam = (await examsDashboard.json()).exams[0];
  const assignExam = await jsonRequest('/exams/assign', { id: exam.id, userKey: parentUserKey });
  assert.equal(assignExam.status, 200);

  const blockedExam = await jsonRequest('/exams/update', {
    examId: exam.id,
    score: 85,
    totalScore: 100,
    status: 'Completed',
    elapsedSeconds: 600,
    userKey
  });
  assert.equal(blockedExam.status, 409);

  const examEvidence = await jsonRequest('/errors/log-text', {
    userKey,
    title: 'Careless calculation',
    description: 'Skipped checking the final answer.',
    category: 'General',
    examId: exam.id
  });
  assert.equal(examEvidence.status, 200);

  const examCompletion = await jsonRequest('/exams/update', {
    examId: exam.id,
    score: 85,
    totalScore: 100,
    status: 'Completed',
    elapsedSeconds: 600,
    userKey
  });
  assert.equal(examCompletion.status, 200);

  const completedDashboard = await jsonRequest('/dashboard', { userKey, profileType: 'parent' });
  const completedData = await completedDashboard.json();
  assert.ok(completedData.alerts.some(alert => alert.type === 'exam'));
});

test('default revision bank remains visible to the parent dashboard and custom items still work', async () => {
  const parentDashboard = await jsonRequest('/dashboard', { userKey, profileType: 'parent' });
  assert.equal(parentDashboard.status, 200);
  const parentData = await parentDashboard.json();
  assert.ok(parentData.revisionTopics.length > 0, 'default revision bank should be visible to parent users');
  assert.ok(parentData.revisionTopics.some(topic => topic.name && topic.subject), 'default revision rows should include name and subject metadata');

  const newExam = await jsonRequest('/exams/add', {
    userKey,
    subject: 'Science',
    name: 'Custom Science Prelim Paper 2026'
  });
  assert.equal(newExam.status, 200);

  const examDashboard = await jsonRequest('/dashboard', { userKey, profileType: 'parent' });
  const examData = await examDashboard.json();
  assert.ok(examData.exams.some(exam => exam.title === 'Custom Science Prelim Paper 2026' && exam.subject === 'Science'));

  const newRevision = await jsonRequest('/revisions/add', {
    userKey,
    subject: 'English',
    name: 'Custom English Revision Drill'
  });
  assert.equal(newRevision.status, 200);
  assert.equal((await newRevision.json()).level, 'P6');

  const selectedLevelRevision = await jsonRequest('/revisions/add', {
    userKey,
    subject: 'English',
    name: 'Custom P4 Revision Drill',
    level: 'P4'
  });
  assert.equal(selectedLevelRevision.status, 200);
  assert.equal((await selectedLevelRevision.json()).level, 'P4');

  const invalidLevelRevision = await jsonRequest('/revisions/add', {
    userKey,
    subject: 'English',
    name: 'Invalid Level Revision Drill',
    level: 'P3'
  });
  assert.equal(invalidLevelRevision.status, 200);
  assert.equal((await invalidLevelRevision.json()).level, 'P6');

  const revisionDashboard = await jsonRequest('/dashboard', { userKey, profileType: 'parent' });
  const revisionData = await revisionDashboard.json();
  assert.ok(revisionData.revisionTopics.some(topic => topic.name === 'Custom English Revision Drill' && topic.subject === 'English'));
});

test('parent dashboard aggregates alerts from linked student syllabus, revision and exam completion', async () => {
  const parentPhone = '7770001111';
  const studentPhone = '7770002222';

  await jsonRequest('/auth/onboard', {
    userKey: parentPhone,
    selectedTopics: [{ name: 'Parent dashboard link trigger', subject: 'Science', level: 'P6' }],
    role: 'parent'
  });

  await jsonRequest('/auth/onboard', {
    userKey: studentPhone,
    selectedTopics: [{ name: 'Student dashboard link trigger', subject: 'Science', level: 'P6' }],
    role: 'student'
  });

  await jsonRequest('/links/create', {
    parentUserKey: parentPhone,
    studentUserKey: studentPhone
  });

  await new Promise((resolve, reject) => {
    db.run('INSERT INTO subject_hub (name, subject, level, confidence, progress, alert_dismissed, user_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['Child topic', 'Science', 'P6', 'High', 100, 0, studentPhone],
      err => err ? reject(err) : resolve());
  });

  await new Promise((resolve, reject) => {
    db.run('INSERT INTO revision_tracker (name, subject, progress, status, assigned, timer_seconds, max_time_minutes, alert_dismissed, alert_dismissed_progress, is_custom, user_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['Child revision', 'Science', 100, 'Completed', 1, 120, 90, 0, 0, 0, studentPhone],
      err => err ? reject(err) : resolve());
  });

  await new Promise((resolve, reject) => {
    db.run('INSERT INTO exam_tracker (name, subject, score, total_score, status, assigned, timer_seconds, max_time_minutes, alert_dismissed, is_custom, user_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['Child prelim', 'Science', 90, 100, 'Completed', 1, 150, 90, 0, 0, studentPhone],
      err => err ? reject(err) : resolve());
  });

  const parentView = await jsonRequest('/dashboard', { userKey: parentPhone, profileType: 'parent' });
  assert.equal(parentView.status, 200);
  const parentData = await parentView.json();

  assert.ok(parentData.alerts.some(alert => alert.type === 'syllabus' && alert.message.includes('Child topic')));
  assert.ok(parentData.alerts.some(alert => alert.type === 'revision' && alert.message.includes('Child revision')));
  assert.ok(parentData.alerts.some(alert => alert.type === 'exam' && alert.message.includes('Child prelim')));
});

test('linked parent receives an alert when student completes an assigned prelim', async () => {
  const parentPhone = '7880001111';
  const studentPhone = '7880002222';

  await jsonRequest('/auth/onboard', {
    userKey: parentPhone,
    selectedTopics: [{ name: 'Prelim alert parent', subject: 'Science', level: 'P6' }],
    role: 'parent'
  });
  await jsonRequest('/auth/onboard', {
    userKey: studentPhone,
    selectedTopics: [{ name: 'Prelim alert student', subject: 'Science', level: 'P6' }],
    role: 'student'
  });
  await jsonRequest('/links/create', { parentUserKey: parentPhone, studentUserKey: studentPhone });

  const parentBefore = await jsonRequest('/dashboard', { userKey: parentPhone, profileType: 'parent' });
  const parentBeforeData = await parentBefore.json();
  const prelim = parentBeforeData.exams.find(exam => exam.subject === 'Science' && exam.user_key === studentPhone && Number(exam.assigned) === 0);
  assert.ok(prelim, 'parent should see an unassigned Science prelim paper for the linked student');

  const assignment = await jsonRequest('/exams/assign', { id: prelim.id, userKey: parentPhone });
  assert.equal(assignment.status, 200);

  const evidence = await jsonRequest('/errors/log-text', {
    userKey: studentPhone,
    title: 'Prelim alert evidence',
    description: 'Student recorded a linked mistake before completing the paper.',
    category: 'General',
    examId: prelim.id
  });
  assert.equal(evidence.status, 200);

  const completion = await jsonRequest('/exams/update', {
    examId: prelim.id,
    score: 88,
    totalScore: 100,
    status: 'Completed',
    elapsedSeconds: 300,
    userKey: studentPhone
  });
  assert.equal(completion.status, 200);

  const studentAfter = await jsonRequest('/dashboard', { userKey: studentPhone, profileType: 'student' });
  assert.equal(studentAfter.status, 200);
  const studentAfterData = await studentAfter.json();
  assert.ok(!studentAfterData.alerts.some(alert => alert.type === 'exam' && alert.message.includes('88/100')));

  const parentAfter = await jsonRequest('/dashboard', { userKey: parentPhone, profileType: 'parent' });
  const parentAfterData = await parentAfter.json();
  assert.ok(parentAfterData.alerts.some(alert => alert.type === 'exam' && alert.message.includes('88/100')));
});

test('student receives an assigned prelim under Targets Owed without a separate alert', async () => {
  const parentPhone = '7880003333';
  const studentPhone = '7880004444';

  await jsonRequest('/auth/onboard', {
    userKey: parentPhone,
    selectedTopics: [{ name: 'Prelim assignment parent', subject: 'Science', level: 'P6' }],
    role: 'parent'
  });
  await jsonRequest('/auth/onboard', {
    userKey: studentPhone,
    selectedTopics: [{ name: 'Prelim assignment student', subject: 'Science', level: 'P6' }],
    role: 'student'
  });
  assert.equal((await jsonRequest('/links/create', { parentUserKey: parentPhone, studentUserKey: studentPhone })).status, 200);

  const parentBefore = await jsonRequest('/dashboard', { userKey: parentPhone, profileType: 'parent' });
  const prelim = (await parentBefore.json()).exams.find(exam => exam.subject === 'Science' && exam.user_key === studentPhone && Number(exam.assigned) === 0);
  assert.ok(prelim, 'parent should see an unassigned student-owned prelim paper');

  const assignment = await jsonRequest('/exams/assign', { id: prelim.id, userKey: parentPhone });
  assert.equal(assignment.status, 200);

  const studentAfter = await jsonRequest('/dashboard', { userKey: studentPhone, profileType: 'student' });
  const studentData = await studentAfter.json();
  assert.ok(studentData.exams.some(exam => exam.id === prelim.id && Number(exam.assigned) === 1));
  assert.ok(!studentData.alerts.some(alert => alert.type === 'exam' && alert.id === prelim.id));
});

test('parent dismissals clear linked child alerts and dismiss-all clears linked alerts too', async () => {
  const parentPhone = '7770003333';
  const studentPhone = '7770004444';

  await jsonRequest('/auth/onboard', {
    userKey: parentPhone,
    selectedTopics: [{ name: 'Parent dismissal link trigger', subject: 'Math', level: 'P6' }],
    role: 'parent'
  });

  await jsonRequest('/auth/onboard', {
    userKey: studentPhone,
    selectedTopics: [{ name: 'Student dismissal link trigger', subject: 'Math', level: 'P6' }],
    role: 'student'
  });

  await jsonRequest('/links/create', {
    parentUserKey: parentPhone,
    studentUserKey: studentPhone
  });

  await new Promise((resolve, reject) => {
    db.run('INSERT INTO subject_hub (name, subject, level, confidence, progress, alert_dismissed, user_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['Linked child lesson', 'Math', 'P6', 'High', 100, 0, studentPhone],
      err => err ? reject(err) : resolve());
  });

  await new Promise((resolve, reject) => {
    db.run('INSERT INTO revision_tracker (name, subject, progress, status, assigned, timer_seconds, max_time_minutes, alert_dismissed, alert_dismissed_progress, is_custom, user_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['Linked child revision', 'Math', 100, 'Completed', 1, 120, 90, 0, 0, 0, studentPhone],
      err => err ? reject(err) : resolve());
  });

  const linkedParentDashboard = await jsonRequest('/dashboard', { userKey: parentPhone, profileType: 'parent' });
  const linkedParentData = await linkedParentDashboard.json();
  assert.ok(linkedParentData.alerts.some(alert => alert.type === 'syllabus' && alert.message.includes('Linked child lesson')));
  assert.ok(linkedParentData.alerts.some(alert => alert.type === 'revision' && alert.message.includes('Linked child revision')));

  const dismissOne = await jsonRequest('/revisions/dismiss-alert', {
    id: linkedParentData.revisionTopics.find(topic => topic.name === 'Linked child revision').id,
    userKey: parentPhone
  });
  assert.equal(dismissOne.status, 200);

  const afterSingleDismiss = await jsonRequest('/dashboard', { userKey: parentPhone, profileType: 'parent' });
  const afterSingleDismissData = await afterSingleDismiss.json();
  assert.ok(!afterSingleDismissData.alerts.some(alert => alert.type === 'revision' && alert.message.includes('Linked child revision')));

  const dismissAll = await jsonRequest('/alerts/dismiss-all', { userKey: parentPhone });
  assert.equal(dismissAll.status, 200);

  const afterDismissAll = await jsonRequest('/dashboard', { userKey: parentPhone, profileType: 'parent' });
  const afterDismissAllData = await afterDismissAll.json();
  assert.ok(!afterDismissAllData.alerts.some(alert => alert.type === 'syllabus' && alert.message.includes('Linked child lesson')));
  assert.ok(!afterDismissAllData.alerts.some(alert => alert.type === 'revision' && alert.message.includes('Linked child revision')));
});

test('linked parents cannot assign the same revision topic twice', async () => {
  const parentPhoneA = '7770005555';
  const parentPhoneB = '7770006666';
  const studentPhone = '7770007777';

  await jsonRequest('/auth/onboard', {
    userKey: parentPhoneA,
    selectedTopics: [{ name: 'Parent A shared assignment', subject: 'Math', level: 'P6' }],
    role: 'parent'
  });

  await jsonRequest('/auth/onboard', {
    userKey: parentPhoneB,
    selectedTopics: [{ name: 'Parent B shared assignment', subject: 'Math', level: 'P6' }],
    role: 'parent'
  });

  await jsonRequest('/auth/onboard', {
    userKey: studentPhone,
    selectedTopics: [{ name: 'Shared assignment student', subject: 'Math', level: 'P6' }],
    role: 'student'
  });

  await jsonRequest('/links/create', {
    parentUserKey: parentPhoneA,
    studentUserKey: studentPhone
  });

  await jsonRequest('/links/create', {
    parentUserKey: parentPhoneB,
    studentUserKey: studentPhone
  });

  await new Promise((resolve, reject) => {
    db.run('INSERT INTO revision_tracker (name, subject, progress, status, assigned, timer_seconds, max_time_minutes, alert_dismissed, alert_dismissed_progress, is_custom, user_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['Shared assignment topic', 'Math', 0, 'Pending', 0, 0, 90, 0, 0, 0, studentPhone],
      err => err ? reject(err) : resolve());
  });

  const parentAView = await jsonRequest('/dashboard', { userKey: parentPhoneA, profileType: 'parent' });
  const parentAData = await parentAView.json();
  const topicId = parentAData.revisionTopics.find(topic => topic.name === 'Shared assignment topic').id;

  const firstAssign = await jsonRequest('/revisions/assign', { id: topicId, userKey: parentPhoneA });
  assert.equal(firstAssign.status, 200);

  const secondAssign = await jsonRequest('/revisions/assign', { id: topicId, userKey: parentPhoneB });
  assert.equal(secondAssign.status, 409);
});

test('two linked parents dismiss alerts independently', async () => {
  const parentPhoneA = '7770005555';
  const parentPhoneB = '7770006666';
  const studentPhone = '7770007777';

  await jsonRequest('/auth/onboard', {
    userKey: parentPhoneA,
    selectedTopics: [{ name: 'Parent A dismissal link', subject: 'Math', level: 'P6' }],
    role: 'parent'
  });

  await jsonRequest('/auth/onboard', {
    userKey: parentPhoneB,
    selectedTopics: [{ name: 'Parent B dismissal link', subject: 'Math', level: 'P6' }],
    role: 'parent'
  });

  await jsonRequest('/auth/onboard', {
    userKey: studentPhone,
    selectedTopics: [{ name: 'Joint student dismissal link', subject: 'Math', level: 'P6' }],
    role: 'student'
  });

  await jsonRequest('/links/create', {
    parentUserKey: parentPhoneA,
    studentUserKey: studentPhone
  });

  await jsonRequest('/links/create', {
    parentUserKey: parentPhoneB,
    studentUserKey: studentPhone
  });

  await new Promise((resolve, reject) => {
    db.run('INSERT INTO revision_tracker (name, subject, progress, status, assigned, timer_seconds, max_time_minutes, alert_dismissed, alert_dismissed_progress, is_custom, user_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['Shared student revision', 'Math', 100, 'Completed', 1, 120, 90, 0, 0, 0, studentPhone],
      err => err ? reject(err) : resolve());
  });

  const parentAView = await jsonRequest('/dashboard', { userKey: parentPhoneA, profileType: 'parent' });
  const parentAData = await parentAView.json();
  assert.ok(parentAData.alerts.some(alert => alert.type === 'revision' && alert.message.includes('Shared student revision')));

  const parentBView = await jsonRequest('/dashboard', { userKey: parentPhoneB, profileType: 'parent' });
  const parentBData = await parentBView.json();
  assert.ok(parentBData.alerts.some(alert => alert.type === 'revision' && alert.message.includes('Shared student revision')));

  const dismissParentA = await jsonRequest('/revisions/dismiss-alert', {
    id: parentAData.revisionTopics.find(topic => topic.name === 'Shared student revision').id,
    userKey: parentPhoneA
  });
  assert.equal(dismissParentA.status, 200);

  const afterParentADismiss = await jsonRequest('/dashboard', { userKey: parentPhoneA, profileType: 'parent' });
  const afterParentAData = await afterParentADismiss.json();
  assert.ok(!afterParentAData.alerts.some(alert => alert.type === 'revision' && alert.message.includes('Shared student revision')));

  const afterParentBDismiss = await jsonRequest('/dashboard', { userKey: parentPhoneB, profileType: 'parent' });
  const afterParentBData = await afterParentBDismiss.json();
  assert.ok(afterParentBData.alerts.some(alert => alert.type === 'revision' && alert.message.includes('Shared student revision')));
});

test('photo uploads use hashed phone and month folders and are retrieved by parent', async () => {
  const form = new FormData();
  form.append('title', 'Silly mistake');
  form.append('description', 'Misread the question instructions.');
  form.append('category', 'General');
  form.append('userKey', userKey);
  form.append('revisionId', '1');
  form.append('photo', new Blob(['test-image'], { type: 'image/jpeg' }), 'mistake.jpg');

  const uploadResponse = await request('/errors/log-with-photo', { method: 'POST', body: form });
  assert.equal(uploadResponse.status, 200);
  const uploadData = await uploadResponse.json();
  assert.match(uploadData.parentPhoneHash, /^[a-f0-9]{64}$/);
  assert.match(uploadData.monthFolder, /^\d{4}-\d{2}$/);
  assert.ok(uploadData.imageUrl.includes(`/${uploadData.parentPhoneHash}/${uploadData.monthFolder}/`));

  const parentDashboard = await jsonRequest('/dashboard', { userKey, profileType: 'parent' });
  const parentData = await parentDashboard.json();
  const mistake = parentData.mistakes.find(item => item.title === 'Silly mistake');
  assert.ok(mistake);
  assert.ok(mistake.photos.some(url => url === uploadData.imageUrl));
  assert.ok(mistake.descriptions.includes('Misread the question instructions.'));
});
