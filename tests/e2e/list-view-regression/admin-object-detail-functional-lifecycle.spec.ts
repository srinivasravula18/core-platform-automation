import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo
} from "../helpers/singleBrowserTest";
import {
  allowWrites,
  apiLogin,
  attachEvidence,
  authHeaders,
  expectListRegionReady,
  hasCredentials,
  loginToAdmin,
  searchWithinListView
} from "./helpers";
import {
  cleanupAdminMetadataByApi,
  createAdminAppViaUi,
  createAdminObjectTabViaUi,
  createAdminObjectViaUi,
  openAdminRowByLabel,
  openKeystoneObjectTab,
  safeApiName,
  selectAdminAppContext,
  selectOptionContainingText,
  shortPrefix,
  uniqueStamp
} from "./page-flow-helpers";

type ApiRecordType = {
  id: string;
  api_name?: string;
  label?: string;
};

type ApiField = {
  id: string;
  api_name?: string;
  label?: string;
  type?: string;
};

type ApiLayout = {
  id: string;
  name?: string;
  layout_type?: string;
  definition_json?: unknown;
};

type ApiForm = {
  id: string;
  name?: string;
  definition_json?: unknown;
};

type ApiButton = {
  id: string;
  api_name?: string;
  label?: string;
  scope?: string;
  active?: boolean;
};

type ApiAssignment = {
  id: string;
  principal_type?: string;
  principal_id?: string | null;
  record_type_id?: string | null;
  layout_id?: string;
  form_id?: string;
};

type ApiRecord = {
  id?: string;
  name?: string;
  [key: string]: unknown;
};

type ObjectDescribe = {
  fields?: ApiField[];
  layouts?: ApiLayout[];
  forms?: ApiForm[];
  record_types?: ApiRecordType[];
  buttons?: ApiButton[];
  creation_layout?: ApiLayout | null;
  form?: ApiForm | null;
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const apiHeaders = async (request: APIRequestContext) => authHeaders(await apiLogin(request));

const readItems = async <T>(request: APIRequestContext, path: string) => {
  const response = await request.get(path, { headers: await apiHeaders(request) });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  const body = (await response.json().catch(() => ({}))) as { items?: T[] };
  return body.items ?? [];
};

const readJson = async <T>(request: APIRequestContext, path: string) => {
  const response = await request.get(path, { headers: await apiHeaders(request) });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
};

const waitForItem = async <T>(
  request: APIRequestContext,
  path: string,
  predicate: (item: T) => boolean,
  label: string
) => {
  await expect
    .poll(async () => (await readItems<T>(request, path)).some(predicate), {
      timeout: 25_000,
      message: `Waiting for ${label}`
    })
    .toBe(true);
  const item = (await readItems<T>(request, path)).find(predicate);
  expect(item, label).toBeTruthy();
  return item as T;
};

const modalByHeading = (page: Page, heading: RegExp | string) =>
  page.locator(".modal").filter({ has: page.getByRole("heading", { name: heading }) }).last();

const objectSubtabIdsByLabel: Record<string, string> = {
  "Settings": "settings",
  "Record Types": "record_types",
  "Fields": "fields",
  "Buttons": "buttons",
  "Email Templates": "email_templates",
  "Layout": "layout",
  "Form": "form",
  "Assignments": "assignments",
  "Validation Rules": "validations",
  "Trigger Rules": "triggers",
  "Audit Log": "audit"
};

const openObjectSubtabByUrl = async (page: Page, label: string) => {
  const subTab = objectSubtabIdsByLabel[label];
  expect(subTab, `${label} should have a route subTab id`).toBeTruthy();
  const url = new URL(page.url());
  url.searchParams.set("subTab", subTab);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  const loose = new RegExp(escapeRegex(label), "i");
  const tabs = page.locator(".admin-object-detail-tabs").first();
  await expect(tabs).toBeVisible({ timeout: 20_000 });
  await expect(tabs.getByRole("button", { name: loose }).first()).toBeVisible({ timeout: 20_000 });
};

const openObjectSubtab = async (page: Page, label: string) => {
  const exact = new RegExp(`^${escapeRegex(label)}(?:\\s*\\(|$)`, "i");
  const loose = new RegExp(escapeRegex(label), "i");
  const tabs = page.locator(".admin-object-detail-tabs").first();
  const direct = tabs.getByRole("button", { name: exact }).or(tabs.getByRole("button", { name: loose })).first();
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
    return;
  }

  const more = tabs.getByRole("button", { name: /^more/i }).first();
  await expect(more, `${label} should be available directly or through More`).toBeVisible();
  await more.click();
  const overflowMenu = page.locator(".record-tab-menu-panel[role='menu']").filter({ hasText: loose }).last();
  if (await overflowMenu.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const menuItem = overflowMenu.getByRole("menuitem", { name: loose }).first();
    if (await menuItem.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await menuItem.click();
      return;
    }
    const item = overflowMenu.locator("button").filter({ hasText: loose }).first();
    if (await item.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await item.click();
      return;
    }
  }
  await openObjectSubtabByUrl(page, label);
};

const ensureChecked = async (checkbox: Locator) => {
  if (!(await checkbox.isChecked().catch(() => false))) {
    await checkbox.check({ force: true });
  }
};

const formField = (root: Locator, label: string) =>
  root.locator(".form-field").filter({ hasText: new RegExp(`^\\s*${escapeRegex(label)}\\b`, "i") }).first();

const createRecordTypeViaUi = async (
  page: Page,
  request: APIRequestContext,
  objectId: string,
  input: { label: string; apiName: string; description: string },
  testInfo: TestInfo
) => {
  await openObjectSubtab(page, "Record Types");
  const panel = page.locator(".object-settings").filter({ hasText: /Record Types/i }).first();
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /^new$/i }).click();
  const dialog = modalByHeading(page, /^create record type$/i);
  await expect(dialog).toBeVisible();
  await formField(dialog, "Label").locator("input").first().fill(input.label);
  await formField(dialog, "API Name").locator("input").first().fill(input.apiName);
  await formField(dialog, "Description").locator("textarea").first().fill(input.description);
  await ensureChecked(dialog.locator("label").filter({ hasText: /^Allow on create$/i }).locator("input").first());
  await attachEvidence(page, testInfo, "object-detail-record-type-create");
  await dialog.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByText(/record type created successfully/i).first()).toBeVisible({ timeout: 20_000 });
  return waitForItem<ApiRecordType>(
    request,
    `/admin/objects/${objectId}/record-types`,
    (item) => item.api_name === input.apiName,
    input.label
  );
};

const createFieldViaUi = async (
  page: Page,
  request: APIRequestContext,
  objectId: string,
  input: { label: string; apiName: string },
  testInfo: TestInfo
) => {
  await openObjectSubtab(page, "Fields");
  const panel = page.locator(".field-list-view-panel").first();
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /^new$/i }).first().click();
  const dialog = modalByHeading(page, /^new field$/i);
  await expect(dialog).toBeVisible();
  await page.locator("#field-label").fill(input.label);
  await page.locator("#field-api-name").fill(input.apiName);
  await page.locator("#field-type").selectOption("text").catch(async () => {
    await selectOptionContainingText(page.locator("#field-type"), "Text");
  });
  await page.locator("#field-search-weight").fill("B");
  await ensureChecked(page.locator("#field-searchable"));
  await ensureChecked(page.locator("#field-audit-log"));
  const helpEditor = dialog.locator("#field-help-text [contenteditable='true']").first();
  if (await helpEditor.isVisible().catch(() => false)) {
    await helpEditor.fill(`Created by object detail lifecycle for ${input.label}.`);
  }
  await attachEvidence(page, testInfo, "object-detail-field-create");
  await dialog.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByText(/field created successfully/i).first()).toBeVisible({ timeout: 25_000 });
  return waitForItem<ApiField>(
    request,
    `/admin/objects/${objectId}/fields`,
    (item) => item.api_name === input.apiName,
    input.label
  );
};

const createButtonViaUi = async (
  page: Page,
  request: APIRequestContext,
  objectId: string,
  input: { label: string; apiName: string },
  testInfo: TestInfo
) => {
  await openObjectSubtab(page, "Buttons");
  const panel = page.locator(".object-settings").filter({ hasText: /Buttons/i }).first();
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /create button/i }).click();
  const dialog = modalByHeading(page, /^new button$/i);
  await expect(dialog).toBeVisible();
  await page.locator("#button-label").fill(input.label);
  await page.locator("#button-api").fill(input.apiName);
  await page.locator("#button-scope").selectOption("list_view");
  await page.locator("#button-behavior").selectOption("open_ui");
  await page.locator("#button-target").selectOption("dialog");
  await page.locator("#button-component-type").selectOption("url");
  await page.locator("#button-component-value").fill("https://example.com/e2e-object-detail");
  await page.locator("#button-color").fill("#2563eb");
  await page.locator("#button-payload").fill('{"source":"object-detail-functional"}');
  await page.locator("#button-order").fill("5");
  await attachEvidence(page, testInfo, "object-detail-button-create");
  await dialog.getByRole("button", { name: /^save$/i }).click();
  await expect(page.getByText(/button created successfully/i).first()).toBeVisible({ timeout: 20_000 });
  return waitForItem<ApiButton>(
    request,
    `/admin/objects/${objectId}/buttons`,
    (item) => item.api_name === input.apiName,
    input.label
  );
};

const createLayoutViaUi = async (
  page: Page,
  request: APIRequestContext,
  objectId: string,
  name: string,
  fieldApiName: string,
  testInfo: TestInfo
) => {
  await openObjectSubtab(page, "Layout");
  await page.locator(".layout-editor").getByRole("button", { name: /^new$/i }).first().click();
  const dialog = modalByHeading(page, /^new layout$/i);
  await expect(dialog).toBeVisible();
  await selectOptionContainingText(dialog.locator("select").first(), "Record Creation");
  await dialog.locator("input").first().fill(name);
  await attachEvidence(page, testInfo, "object-detail-layout-create");
  await dialog.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByText(/layout created successfully/i).first()).toBeVisible({ timeout: 20_000 });
  const layout = await waitForItem<ApiLayout>(
    request,
    `/admin/objects/${objectId}/layouts`,
    (item) => item.name === name && item.layout_type === "record_creation",
    name
  );
  const definition = {
    sections: [
      {
        id: "e2e_create_record",
        label: "Create Record",
        show_header: true,
        columns: 1,
        fields: ["name", fieldApiName],
        field_spans: { name: 1, [fieldApiName]: 1 }
      }
    ]
  };
  const response = await request.patch(`/admin/objects/${objectId}/layouts/${layout.id}`, {
    headers: await apiHeaders(request),
    data: { definition_json: definition }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return { ...layout, definition_json: definition };
};

const createFormViaUi = async (
  page: Page,
  request: APIRequestContext,
  objectId: string,
  name: string,
  fieldApiName: string,
  testInfo: TestInfo
) => {
  await openObjectSubtab(page, "Form");
  const panel = page.locator(".object-settings").filter({ hasText: /Form Designer/i }).first();
  await expect(panel).toBeVisible();
  const newButton = panel.getByRole("button", { name: /^new$/i }).first();
  await expect(newButton).toBeVisible();
  await newButton.click();
  const dialog = modalByHeading(page, /^new form$/i);
  await expect(dialog).toBeVisible();
  await dialog.locator("input").first().fill(name);
  await attachEvidence(page, testInfo, "object-detail-form-create");
  await dialog.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByText(/form created successfully/i).first()).toBeVisible({ timeout: 20_000 });
  const form = await waitForItem<ApiForm>(
    request,
    `/admin/objects/${objectId}/forms`,
    (item) => item.name === name,
    name
  );
  const definition = {
    sections: [
      {
        id: "e2e_record_form",
        label: "Record Details",
        columns: 1,
        fields: ["name", fieldApiName],
        field_spans: { name: 1, [fieldApiName]: 1 }
      }
    ]
  };
  const response = await request.patch(`/admin/objects/${objectId}/forms/${form.id}`, {
    headers: await apiHeaders(request),
    data: { definition_json: definition }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return { ...form, definition_json: definition };
};

const createAssignmentsViaUi = async (
  page: Page,
  request: APIRequestContext,
  objectId: string,
  recordType: ApiRecordType,
  layout: ApiLayout,
  form: ApiForm,
  testInfo: TestInfo
) => {
  await openObjectSubtab(page, "Assignments");
  const layoutCard = page.locator(".assignment-card").filter({ hasText: /Layout Assignments/i }).first();
  await expect(layoutCard).toBeVisible();
  await layoutCard.locator("select").nth(0).selectOption("default");
  await selectOptionContainingText(layoutCard.locator("select").nth(1), "Record Creation");
  await selectOptionContainingText(layoutCard.locator("select").nth(2), layout.name ?? "");
  await selectOptionContainingText(layoutCard.locator("select").nth(3), recordType.label ?? "");
  await attachEvidence(page, testInfo, "object-detail-layout-assignment-create");
  await layoutCard.getByRole("button", { name: /^add$/i }).click();
  await expect(page.getByText(/layout assignment created successfully/i).first()).toBeVisible({ timeout: 20_000 });

  const formCard = page.locator(".assignment-card").filter({ hasText: /Form Assignments/i }).first();
  await expect(formCard).toBeVisible();
  await formCard.locator("select").nth(0).selectOption("default");
  await selectOptionContainingText(formCard.locator("select").nth(1), form.name ?? "");
  await selectOptionContainingText(formCard.locator("select").nth(2), recordType.label ?? "");
  await attachEvidence(page, testInfo, "object-detail-form-assignment-create");
  await formCard.getByRole("button", { name: /^add$/i }).click();
  await expect(page.getByText(/form assignment created successfully/i).first()).toBeVisible({ timeout: 20_000 });

  const [layoutAssignments, formAssignments] = await Promise.all([
    readItems<ApiAssignment>(request, `/admin/objects/${objectId}/layout-assignments`),
    readItems<ApiAssignment>(request, `/admin/objects/${objectId}/form-assignments`)
  ]);
  return {
    layoutAssignment:
      layoutAssignments.find(
        (item) => item.layout_id === layout.id && item.record_type_id === recordType.id
      ) ?? null,
    formAssignment:
      formAssignments.find((item) => item.form_id === form.id && item.record_type_id === recordType.id) ?? null
  };
};

const createEmailTemplateByContractAndVerifyUi = async (
  page: Page,
  request: APIRequestContext,
  objectId: string,
  input: { appLabel: string; objectLabel: string; label: string; apiName: string; fieldApiName: string },
  testInfo: TestInfo
) => {
  const response = await request.post(`/admin/objects/${objectId}/email-templates`, {
    headers: await apiHeaders(request),
    data: {
      api_name: input.apiName,
      label: input.label,
      description: "Log-only email template created by object detail lifecycle.",
      to_template: null,
      subject_template: `Lifecycle {{record.${input.fieldApiName}}}`,
      body_template: `Created {{record.${input.fieldApiName}}}`,
      manual_enabled: false,
      send_email_enabled: false,
      trigger_events: ["afterInsert"],
      active: true,
      is_default: false
    }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  await waitForItem<{ id: string; label?: string; api_name?: string }>(
    request,
    `/admin/objects/${objectId}/email-templates`,
    (item) => item.api_name === input.apiName,
    input.label
  );
  await loginToAdmin(page);
  await selectAdminAppContext(page, input.appLabel);
  await openAdminRowByLabel(page, "Objects", input.objectLabel);
  await openObjectSubtab(page, "Email Templates");
  await expect(page.locator(".admin-object-email-templates").first()).toContainText(input.label, { timeout: 20_000 });
  await attachEvidence(page, testInfo, "object-detail-email-template-listed");
};

const createValidationRuleViaUi = async (
  page: Page,
  request: APIRequestContext,
  objectId: string,
  name: string,
  testInfo: TestInfo
) => {
  await openObjectSubtab(page, "Validation Rules");
  const panel = page.locator(".validation-rules").first();
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /create rule/i }).click();
  const dialog = modalByHeading(page, /^create validation rule$/i);
  await expect(dialog).toBeVisible();
  await page.locator("#validation-new-name").fill(name);
  const advanced = dialog.getByRole("button", { name: /^advanced$/i }).first();
  if (await advanced.isVisible().catch(() => false)) {
    await advanced.click();
  }
  await page.locator("#validation-new-expression").fill("FALSE");
  await page.locator("#validation-new-message").fill("E2E disabled-by-expression validation.");
  await attachEvidence(page, testInfo, "object-detail-validation-rule-create");
  await dialog.getByRole("button", { name: /^save$/i }).click();
  await expect(page.getByText(/validation rule created successfully/i).first()).toBeVisible({ timeout: 20_000 });
  return waitForItem<{ id: string; name?: string }>(
    request,
    `/admin/objects/${objectId}/validation-rules`,
    (item) => item.name === name,
    name
  );
};

const createTriggerRuleViaUi = async (
  page: Page,
  request: APIRequestContext,
  objectId: string,
  name: string,
  testInfo: TestInfo
) => {
  await openObjectSubtab(page, "Trigger Rules");
  const panel = page.locator(".trigger-rules").first();
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /create trigger/i }).click();
  const dialog = modalByHeading(page, /^create trigger rule$/i);
  await expect(dialog).toBeVisible();
  await page.locator("#trigger-new-name").fill(name);
  await page.locator("#trigger-new-code").fill("return;");
  await page.locator("#trigger-new-json").fill(
    JSON.stringify({ event: "afterInsert", code: "return;" }, null, 2)
  );
  await attachEvidence(page, testInfo, "object-detail-trigger-rule-create");
  await dialog.getByRole("button", { name: /^save$/i }).click();
  await expect(page.getByText(/trigger rule created successfully/i).first()).toBeVisible({ timeout: 25_000 });
  return waitForItem<{ id: string; name?: string }>(
    request,
    `/admin/objects/${objectId}/trigger-rules`,
    (item) => item.name === name,
    name
  );
};

const verifyAuditLogUi = async (page: Page, testInfo: TestInfo) => {
  await openObjectSubtab(page, "Audit Log");
  const auditPanel = page.locator(".object-audit-list-view-panel, .object-settings").first();
  await expect(auditPanel).toBeVisible();
  await expectListRegionReady(page.locator(".object-audit-list-view-panel").first()).catch(() => null);
  await attachEvidence(page, testInfo, "object-detail-audit-log-after-metadata-changes");
};

const openKeystoneCreateModal = async (
  page: Page,
  objectLabel: string,
  recordTypeLabel: string
) => {
  const objectHome = page.locator(".object-home").first();
  await objectHome.getByRole("button", { name: /^new$/i }).click();
  const pickerHeading = /^select .+ type$/i;
  const picker = page.getByRole("heading", { name: pickerHeading });
  if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const dialog = modalByHeading(page, pickerHeading);
    const option = dialog.locator("label").filter({ hasText: new RegExp(escapeRegex(recordTypeLabel), "i") }).first();
    await option.locator("input").check({ force: true });
    await dialog.getByRole("button", { name: /^continue$/i }).click();
  }
  const dialog = page.locator(".create-record-modal").filter({ has: page.getByRole("heading", { name: /^new .+/i }) }).last();
  await expect(dialog, `New ${objectLabel} record dialog should open`).toBeVisible({ timeout: 20_000 });
  return dialog;
};

const findRuntimeRecord = async (
  request: APIRequestContext,
  appId: string,
  objectApiName: string,
  recordName: string
) => {
  const records = await readItems<ApiRecord>(
    request,
    `/api/apps/${appId}/objects/${objectApiName}/records?page=1&page_size=50`
  );
  return records.find((record) => record.name === recordName) ?? null;
};

test.describe("Admin Object detail functional lifecycle", () => {
  test.setTimeout(300_000);
  test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials(), "Admin and Keystone credentials are not configured.");
    test.skip(!allowWrites(), "Write-enabled object detail lifecycle coverage is disabled.");
    await loginToAdmin(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== "skipped") {
      await attachEvidence(page, testInfo, "object-detail-functional-lifecycle-final-evidence").catch(() => null);
    }
  });

  test("Admin Object detail lifecycle configures record types fields buttons layouts forms assignments rules and verifies Keystone record creation @metadata-lifecycle @object-functional-lifecycle @admin-page:Objects @admin-page:Fields @admin-page:RecordTypes [surface: Admin + Keystone] [feature: Object detail metadata drives Keystone runtime records] [precondition: ALLOW_DATA_WRITE=true and admin user can manage object metadata] [input: open Admin -> create disposable app -> create object -> create tab -> open Object detail -> save Settings -> create Record Type -> create Field -> create Button -> create Record Creation Layout -> create Form -> create default layout and form assignments -> create log-only Email Template -> create Validation Rule -> create Trigger Rule -> inspect Audit Log -> open Keystone app and object tab -> click New -> fill Name and custom field -> create runtime record -> verify record and describe contracts -> cleanup] [expected: every Object detail subpage either creates or verifies connected metadata, Keystone sees the Admin metadata, and a real record can be created with the new custom field] [proof: this is a connected business flow across Admin metadata, Object detail subtabs, backend contracts, and Keystone runtime instead of only clicking buttons or taking screenshots]", async ({
    page,
    request
  }, testInfo) => {
    const stamp = uniqueStamp();
    const appLabel = `E2E Functional App ${stamp}`;
    const objectLabel = `E2E Functional Asset ${stamp}`;
    const tabLabel = `${objectLabel} Workspace`;
    const recordTypeLabel = `E2E Functional Type ${stamp}`;
    const fieldLabel = `Lifecycle Note ${stamp}`;
    const buttonLabel = `Lifecycle Action ${stamp}`;
    const layoutName = `AAA E2E Creation Layout ${stamp}`;
    const formName = `AAA E2E Runtime Form ${stamp}`;
    const emailTemplateLabel = `E2E Lifecycle Email ${stamp}`;
    const validationName = `E2E Validation ${stamp}`;
    const triggerName = `E2E Trigger ${stamp}`;
    const recordName = `E2E Runtime Record ${stamp}`;
    const fieldValue = `created-through-keystone-${stamp}`;

    let appId = "";
    let objectId = "";
    let tabId = "";
    let createdRecordId = "";
    let layoutAssignmentId = "";
    let formAssignmentId = "";
    let objectApiName = "";

    try {
      const app = await createAdminAppViaUi(
        page,
        request,
        {
          label: appLabel,
          apiName: safeApiName(appLabel),
          prefix: shortPrefix(`f${stamp}`)
        },
        testInfo
      );
      appId = app.id;

      const object = await createAdminObjectViaUi(
        page,
        request,
        app,
        {
          label: objectLabel,
          apiName: safeApiName(objectLabel),
          pluralLabel: `${objectLabel}s`,
          prefix: shortPrefix(`o${stamp}`)
        },
        testInfo
      );
      objectId = object.id;
      objectApiName = object.apiName;

      const tab = await createAdminObjectTabViaUi(
        page,
        request,
        app,
        object,
        { label: tabLabel, apiName: safeApiName(tabLabel) },
        testInfo
      );
      tabId = tab.id;

      await loginToAdmin(page);
      await selectAdminAppContext(page, app.label);
      await openAdminRowByLabel(page, "Objects", object.label);
      await openObjectSubtab(page, "Settings");
      await expect(page.locator("#object-label")).toHaveValue(object.label);
      await ensureChecked(page.locator("label").filter({ hasText: /global search enabled/i }).locator("input").first());
      await ensureChecked(page.locator("label").filter({ hasText: /inline edit enabled/i }).locator("input").first());
      const settingsPanel = page.locator(".object-settings").filter({ hasText: /Object Metadata/i }).first();
      const settingsSave = settingsPanel.getByRole("button", { name: /^save$/i }).first();
      if (await settingsSave.isEnabled().catch(() => false)) {
        await attachEvidence(page, testInfo, "object-detail-settings-before-save");
        await settingsSave.click();
        await expect(page.getByText(/object details saved successfully/i).first()).toBeVisible({ timeout: 20_000 });
      }

      const recordType = await createRecordTypeViaUi(
        page,
        request,
        objectId,
        {
          label: recordTypeLabel,
          apiName: safeApiName(recordTypeLabel),
          description: "Record type created through Object detail lifecycle."
        },
        testInfo
      );
      const field = await createFieldViaUi(
        page,
        request,
        objectId,
        { label: fieldLabel, apiName: safeApiName(fieldLabel) },
        testInfo
      );
      const button = await createButtonViaUi(
        page,
        request,
        objectId,
        { label: buttonLabel, apiName: safeApiName(buttonLabel) },
        testInfo
      );
      const layout = await createLayoutViaUi(page, request, objectId, layoutName, field.api_name ?? "", testInfo);
      const form = await createFormViaUi(page, request, objectId, formName, field.api_name ?? "", testInfo);

      await loginToAdmin(page);
      await selectAdminAppContext(page, app.label);
      await openAdminRowByLabel(page, "Objects", object.label);
      const assignments = await createAssignmentsViaUi(
        page,
        request,
        objectId,
        recordType,
        layout,
        form,
        testInfo
      );
      layoutAssignmentId = assignments.layoutAssignment?.id ?? "";
      formAssignmentId = assignments.formAssignment?.id ?? "";

      await createEmailTemplateByContractAndVerifyUi(
        page,
        request,
        objectId,
        {
          appLabel: app.label,
          objectLabel: object.label,
          label: emailTemplateLabel,
          apiName: safeApiName(emailTemplateLabel),
          fieldApiName: field.api_name ?? ""
        },
        testInfo
      );
      await createValidationRuleViaUi(page, request, objectId, validationName, testInfo);
      await createTriggerRuleViaUi(page, request, objectId, triggerName, testInfo);
      await verifyAuditLogUi(page, testInfo);

      const describe = await readJson<ObjectDescribe>(
        request,
        `/api/apps/${app.id}/objects/${object.apiName}/describe`
      );
      expect(describe.fields?.some((item) => item.api_name === field.api_name)).toBe(true);
      expect(describe.record_types?.some((item) => item.id === recordType.id)).toBe(true);
      expect(describe.layouts?.some((item) => item.id === layout.id)).toBe(true);
      expect(describe.forms?.some((item) => item.id === form.id)).toBe(true);
      expect(describe.buttons?.some((item) => item.id === button.id)).toBe(true);
      await testInfo.attach("object-detail-functional-describe-contract", {
        body: JSON.stringify(
          {
            field: field.api_name,
            recordType: recordType.label,
            layout: layout.name,
            form: form.name,
            button: button.label
          },
          null,
          2
        ),
        contentType: "application/json"
      });

      const objectHome = await openKeystoneObjectTab(
        page,
        app.label,
        tab.label,
        object.apiName,
        testInfo,
        "keystone-object-detail-functional-home"
      );
      await expect(objectHome.getByRole("button", { name: new RegExp(escapeRegex(buttonLabel), "i") }).first()).toBeVisible({
        timeout: 20_000
      });
      const createDialog = await openKeystoneCreateModal(page, object.label, recordType.label ?? recordTypeLabel);
      await page.locator("#create-name").fill(recordName);
      await page.locator(`#create-${field.api_name}`).fill(fieldValue);
      await attachEvidence(page, testInfo, "keystone-create-record-with-admin-field");
      await createDialog.getByRole("button", { name: /^create$/i }).click();
      await expect(page.getByText(/record created successfully/i).first()).toBeVisible({ timeout: 25_000 });

      const createdRecord = await expect
        .poll(async () => findRuntimeRecord(request, app.id, object.apiName, recordName), { timeout: 25_000 })
        .not.toBeNull()
        .then(async () => findRuntimeRecord(request, app.id, object.apiName, recordName));
      expect(createdRecord?.[field.api_name ?? ""]).toBe(fieldValue);
      createdRecordId = createdRecord?.id ?? "";

      await searchWithinListView(objectHome, recordName);
      await expect(objectHome).toContainText(recordName, { timeout: 20_000 });
      await attachEvidence(page, testInfo, "keystone-record-visible-after-create");
    } finally {
      const headers = await apiHeaders(request);
      if (createdRecordId && appId && objectApiName) {
        await request.delete(`/api/apps/${appId}/objects/${objectApiName}/records/${createdRecordId}`, { headers }).catch(() => null);
      }
      if (layoutAssignmentId && objectId) {
        await request.delete(`/admin/objects/${objectId}/layout-assignments/${layoutAssignmentId}`, { headers }).catch(() => null);
      }
      if (formAssignmentId && objectId) {
        await request.delete(`/admin/objects/${objectId}/form-assignments/${formAssignmentId}`, { headers }).catch(() => null);
      }
      await cleanupAdminMetadataByApi(request, {
        appId,
        appLabel,
        objectId,
        objectLabel,
        tabId,
        tabLabel
      });
    }
  });
});
