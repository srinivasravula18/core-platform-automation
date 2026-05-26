import { expect, test } from "@playwright/test";
import {
  apiLogin,
  attachEvidence,
  hasCredentials,
  loginToAdmin,
  loginToKeystone,
  openAdminScreen,
  selectKeystoneAppAndTab
} from "../helpers";

const generatedCases = [
  {
    "id": "AGENT_001_01",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Admin regression for Admin",
    "testCase": "Sanity verifies validation happy path after AdminConfirmModal.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminConfirmModal.tsx. | Capture evidence after the happy path completes.",
    "expected": "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    "risk": "Low",
    "sourcePath": "apps/admin/src/components/AdminConfirmModal.tsx",
    "surfaceLabel": "Admin",
    "feature": "Validation",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Sanity",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Focused sanity coverage for apps/admin/src/components/AdminConfirmModal.tsx.",
    "evidenceName": "agent-agent_001_01",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_001_01",
        "title": "@sanity Sanity verifies validation happy path after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminConfirmModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Sanity verifies validation happy path after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 14
      },
      {
        "id": "AGENT_003_01",
        "title": "@sanity Sanity verifies validation happy path after AdminFieldModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminFieldModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/components/AdminFieldModal.tsx.]",
        "displayTitle": "Sanity verifies validation happy path after AdminFieldModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 13
      },
      {
        "id": "AGENT_002_02",
        "title": "@sanity Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (file_neighbors) links the change to this feature path.]",
        "displayTitle": "Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 12
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_001_01 covers this Sanity scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Sanity verifies validation happy path after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminConfirmModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/components/AdminConfirmModal.tsx.]"
  },
  {
    "id": "AGENT_001_02",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Admin regression for Admin",
    "testCase": "Validation checks guarded behavior after AdminConfirmModal.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted Admin feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.",
    "expected": "Invalid or unauthorized input is rejected with a safe error state and no crash.",
    "risk": "Low",
    "sourcePath": "apps/admin/src/components/AdminConfirmModal.tsx",
    "surfaceLabel": "Admin",
    "feature": "Validation",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Validation",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Guarded behavior coverage for apps/admin/src/components/AdminConfirmModal.tsx.",
    "evidenceName": "agent-agent_001_02",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_001_02",
        "title": "@sanity Validation checks guarded behavior after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Validation checks guarded behavior after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 13
      },
      {
        "id": "AGENT_003_02",
        "title": "@sanity Validation checks guarded behavior after AdminFieldModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/admin/src/components/AdminFieldModal.tsx.]",
        "displayTitle": "Validation checks guarded behavior after AdminFieldModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 12
      },
      {
        "id": "AGENT_001_03",
        "title": "@regression Regression protects downstream validation behavior after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminConfirmModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Regression protects downstream validation behavior after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 11
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_001_02 covers this Validation scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Validation checks guarded behavior after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/admin/src/components/AdminConfirmModal.tsx.]"
  },
  {
    "id": "AGENT_001_03",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Admin regression for Admin",
    "testCase": "Regression protects downstream validation behavior after AdminConfirmModal.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open a downstream Admin workflow connected to apps/admin/src/components/AdminConfirmModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.",
    "expected": "Connected downstream behavior remains stable after the code change.",
    "risk": "Low",
    "sourcePath": "apps/admin/src/components/AdminConfirmModal.tsx",
    "surfaceLabel": "Admin",
    "feature": "Validation",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Regression",
    "level": "Regression",
    "tag": "@regression",
    "proof": "Downstream regression coverage for apps/admin/src/components/AdminConfirmModal.tsx.",
    "evidenceName": "agent-agent_001_03",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_001_03",
        "title": "@regression Regression protects downstream validation behavior after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminConfirmModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Regression protects downstream validation behavior after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 14
      },
      {
        "id": "AGENT_003_03",
        "title": "@regression Regression protects downstream validation behavior after AdminFieldModal.tsx [surface: Admin] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminFieldModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/components/AdminFieldModal.tsx.]",
        "displayTitle": "Regression protects downstream validation behavior after AdminFieldModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 13
      },
      {
        "id": "AGENT_002_05",
        "title": "@regression Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (file_neighbors) provides downstream relationship context.]",
        "displayTitle": "Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 12
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_001_03 covers this Regression scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression protects downstream validation behavior after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminConfirmModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/components/AdminConfirmModal.tsx.]"
  },
  {
    "id": "AGENT_002_01",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Security regression for Admin",
    "testCase": "BVT verifies security remains reachable after AdminCreateAccessRecordModal.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Sign in to Admin. | Open the impacted application shell or screen related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Assert the shell renders without auth, permission, or crash failures.",
    "expected": "The critical impacted surface remains reachable and authenticated behavior is intact.",
    "risk": "High",
    "sourcePath": "apps/admin/src/components/AdminCreateAccessRecordModal.tsx",
    "surfaceLabel": "Admin",
    "feature": "Security",
    "adminScreen": "Permissions",
    "graphSource": "gitnexus-mcp",
    "graphEvidence": "file_neighbors",
    "gitNexus": {
      "path": "apps/admin/src/components/AdminCreateAccessRecordModal.tsx",
      "area": "Admin",
      "risk": "High",
      "tools": [
        "cypher"
      ],
      "neighborhood": "{\n  \"markdown\": \"| labels | name | filePath | relation |\\n| --- | --- | --- | --- |\\n| Const | AdminCreateAccessRecordModal | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | principalOptions | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | parsedErrors | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | objectError | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | principalError | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | summaryMessages | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Folder | components | apps/admin/src/components | CONTAINS |\\n| Function | AdminCreateAccessRecordModal | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Function | parsedErrors | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Function | summaryMessages | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| File | accessPermissions.ts | apps/admin/src/accessPermissions.ts | IMPORTS |\\n| File | dialogErrors.ts | apps/admin/src/components/dialogErrors.ts | IMPORTS |\\n| File | AttachmentAccessEditor.tsx | apps/admin/src/components/AttachmentAccessEditor.tsx | IMPORTS |\\n| File | AdminAccessControlsPanel.tsx | apps/admin/src/components/AdminAccessControlsPanel.tsx | IMPORTS |\\n| File | AccessPermissionHelp.tsx | apps/admin/src/components/AccessPermissionHelp.tsx | IMPORTS |\\n| File | AccessFieldPermissionsEditor.tsx | apps/admin/src/components/AccessFieldPermissionsEditor.tsx | IMPORTS |\",\n  \"row_count\": 16\n}\n\n---\n**Next:** To explore a result symbol, use context({name: \"<name>\", repo: \"core-platform\"}). For schema reference, READ gitnexus://repo/core-platform/schema."
    },
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "BVT",
    "level": "BVT",
    "tag": "@bvt",
    "proof": "GitNexus MCP evidence (file_neighbors) identifies this as critical impact.",
    "evidenceName": "agent-agent_002_01",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_002_01",
        "title": "@bvt BVT verifies security remains reachable after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Sign in to Admin. | Open the impacted application shell or screen related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Assert the shell renders without auth, permission, or crash failures.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: GitNexus MCP evidence (file_neighbors) identifies this as critical impact.]",
        "displayTitle": "BVT verifies security remains reachable after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 14
      },
      {
        "id": "AGENT_002_02",
        "title": "@sanity Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (file_neighbors) links the change to this feature path.]",
        "displayTitle": "Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 11
      },
      {
        "id": "AGENT_002_04",
        "title": "@regression Regression verifies guarded write flow after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: GitNexus MCP evidence (file_neighbors) identifies mutation or lifecycle impact.]",
        "displayTitle": "Regression verifies guarded write flow after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 11
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_002_01 covers this BVT scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@bvt BVT verifies security remains reachable after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Sign in to Admin. | Open the impacted application shell or screen related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Assert the shell renders without auth, permission, or crash failures.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: GitNexus MCP evidence (file_neighbors) identifies this as critical impact.]"
  },
  {
    "id": "AGENT_002_02",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Security regression for Admin",
    "testCase": "Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Capture evidence after the happy path completes.",
    "expected": "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    "risk": "High",
    "sourcePath": "apps/admin/src/components/AdminCreateAccessRecordModal.tsx",
    "surfaceLabel": "Admin",
    "feature": "Security",
    "adminScreen": "Permissions",
    "graphSource": "gitnexus-mcp",
    "graphEvidence": "file_neighbors",
    "gitNexus": {
      "path": "apps/admin/src/components/AdminCreateAccessRecordModal.tsx",
      "area": "Admin",
      "risk": "High",
      "tools": [
        "cypher"
      ],
      "neighborhood": "{\n  \"markdown\": \"| labels | name | filePath | relation |\\n| --- | --- | --- | --- |\\n| Const | AdminCreateAccessRecordModal | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | principalOptions | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | parsedErrors | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | objectError | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | principalError | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | summaryMessages | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Folder | components | apps/admin/src/components | CONTAINS |\\n| Function | AdminCreateAccessRecordModal | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Function | parsedErrors | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Function | summaryMessages | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| File | accessPermissions.ts | apps/admin/src/accessPermissions.ts | IMPORTS |\\n| File | dialogErrors.ts | apps/admin/src/components/dialogErrors.ts | IMPORTS |\\n| File | AttachmentAccessEditor.tsx | apps/admin/src/components/AttachmentAccessEditor.tsx | IMPORTS |\\n| File | AdminAccessControlsPanel.tsx | apps/admin/src/components/AdminAccessControlsPanel.tsx | IMPORTS |\\n| File | AccessPermissionHelp.tsx | apps/admin/src/components/AccessPermissionHelp.tsx | IMPORTS |\\n| File | AccessFieldPermissionsEditor.tsx | apps/admin/src/components/AccessFieldPermissionsEditor.tsx | IMPORTS |\",\n  \"row_count\": 16\n}\n\n---\n**Next:** To explore a result symbol, use context({name: \"<name>\", repo: \"core-platform\"}). For schema reference, READ gitnexus://repo/core-platform/schema."
    },
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Sanity",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "GitNexus MCP evidence (file_neighbors) links the change to this feature path.",
    "evidenceName": "agent-agent_002_02",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_002_02",
        "title": "@sanity Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (file_neighbors) links the change to this feature path.]",
        "displayTitle": "Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 14
      },
      {
        "id": "AGENT_001_01",
        "title": "@sanity Sanity verifies validation happy path after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminConfirmModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Sanity verifies validation happy path after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 12
      },
      {
        "id": "AGENT_002_04",
        "title": "@regression Regression verifies guarded write flow after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: GitNexus MCP evidence (file_neighbors) identifies mutation or lifecycle impact.]",
        "displayTitle": "Regression verifies guarded write flow after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 12
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_002_02 covers this Sanity scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (file_neighbors) links the change to this feature path.]"
  },
  {
    "id": "AGENT_002_03",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Security regression for Admin",
    "testCase": "Security checks guarded behavior after AdminCreateAccessRecordModal.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted Admin feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.",
    "expected": "Invalid or unauthorized input is rejected with a safe error state and no crash.",
    "risk": "High",
    "sourcePath": "apps/admin/src/components/AdminCreateAccessRecordModal.tsx",
    "surfaceLabel": "Admin",
    "feature": "Security",
    "adminScreen": "Permissions",
    "graphSource": "gitnexus-mcp",
    "graphEvidence": "file_neighbors",
    "gitNexus": {
      "path": "apps/admin/src/components/AdminCreateAccessRecordModal.tsx",
      "area": "Admin",
      "risk": "High",
      "tools": [
        "cypher"
      ],
      "neighborhood": "{\n  \"markdown\": \"| labels | name | filePath | relation |\\n| --- | --- | --- | --- |\\n| Const | AdminCreateAccessRecordModal | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | principalOptions | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | parsedErrors | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | objectError | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | principalError | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | summaryMessages | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Folder | components | apps/admin/src/components | CONTAINS |\\n| Function | AdminCreateAccessRecordModal | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Function | parsedErrors | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Function | summaryMessages | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| File | accessPermissions.ts | apps/admin/src/accessPermissions.ts | IMPORTS |\\n| File | dialogErrors.ts | apps/admin/src/components/dialogErrors.ts | IMPORTS |\\n| File | AttachmentAccessEditor.tsx | apps/admin/src/components/AttachmentAccessEditor.tsx | IMPORTS |\\n| File | AdminAccessControlsPanel.tsx | apps/admin/src/components/AdminAccessControlsPanel.tsx | IMPORTS |\\n| File | AccessPermissionHelp.tsx | apps/admin/src/components/AccessPermissionHelp.tsx | IMPORTS |\\n| File | AccessFieldPermissionsEditor.tsx | apps/admin/src/components/AccessFieldPermissionsEditor.tsx | IMPORTS |\",\n  \"row_count\": 16\n}\n\n---\n**Next:** To explore a result symbol, use context({name: \"<name>\", repo: \"core-platform\"}). For schema reference, READ gitnexus://repo/core-platform/schema."
    },
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Security",
    "level": "BVT",
    "tag": "@bvt",
    "proof": "GitNexus MCP evidence (file_neighbors) indicates guarded logic impact.",
    "evidenceName": "agent-agent_002_03",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_002_04",
        "title": "@regression Regression verifies guarded write flow after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: GitNexus MCP evidence (file_neighbors) identifies mutation or lifecycle impact.]",
        "displayTitle": "Regression verifies guarded write flow after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 12
      },
      {
        "id": "AGENT_001_02",
        "title": "@sanity Validation checks guarded behavior after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Validation checks guarded behavior after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 11
      },
      {
        "id": "AGENT_002_01",
        "title": "@bvt BVT verifies security remains reachable after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Sign in to Admin. | Open the impacted application shell or screen related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Assert the shell renders without auth, permission, or crash failures.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: GitNexus MCP evidence (file_neighbors) identifies this as critical impact.]",
        "displayTitle": "BVT verifies security remains reachable after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 11
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_002_04 covers this Security scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@bvt Security checks guarded behavior after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: GitNexus MCP evidence (file_neighbors) indicates guarded logic impact.]"
  },
  {
    "id": "AGENT_002_04",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Security regression for Admin",
    "testCase": "Regression verifies guarded write flow after AdminCreateAccessRecordModal.tsx",
    "precondition": "ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.",
    "steps": "Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Verify cleanup or reset restores seeded state.",
    "expected": "The write flow works on seeded/disposable data and the reset path can restore the local dataset.",
    "risk": "High",
    "sourcePath": "apps/admin/src/components/AdminCreateAccessRecordModal.tsx",
    "surfaceLabel": "Admin",
    "feature": "Security",
    "adminScreen": "Permissions",
    "graphSource": "gitnexus-mcp",
    "graphEvidence": "file_neighbors",
    "gitNexus": {
      "path": "apps/admin/src/components/AdminCreateAccessRecordModal.tsx",
      "area": "Admin",
      "risk": "High",
      "tools": [
        "cypher"
      ],
      "neighborhood": "{\n  \"markdown\": \"| labels | name | filePath | relation |\\n| --- | --- | --- | --- |\\n| Const | AdminCreateAccessRecordModal | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | principalOptions | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | parsedErrors | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | objectError | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | principalError | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | summaryMessages | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Folder | components | apps/admin/src/components | CONTAINS |\\n| Function | AdminCreateAccessRecordModal | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Function | parsedErrors | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Function | summaryMessages | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| File | accessPermissions.ts | apps/admin/src/accessPermissions.ts | IMPORTS |\\n| File | dialogErrors.ts | apps/admin/src/components/dialogErrors.ts | IMPORTS |\\n| File | AttachmentAccessEditor.tsx | apps/admin/src/components/AttachmentAccessEditor.tsx | IMPORTS |\\n| File | AdminAccessControlsPanel.tsx | apps/admin/src/components/AdminAccessControlsPanel.tsx | IMPORTS |\\n| File | AccessPermissionHelp.tsx | apps/admin/src/components/AccessPermissionHelp.tsx | IMPORTS |\\n| File | AccessFieldPermissionsEditor.tsx | apps/admin/src/components/AccessFieldPermissionsEditor.tsx | IMPORTS |\",\n  \"row_count\": 16\n}\n\n---\n**Next:** To explore a result symbol, use context({name: \"<name>\", repo: \"core-platform\"}). For schema reference, READ gitnexus://repo/core-platform/schema."
    },
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": true,
    "scenarioFamily": "Mutation",
    "level": "Regression",
    "tag": "@regression",
    "proof": "GitNexus MCP evidence (file_neighbors) identifies mutation or lifecycle impact.",
    "evidenceName": "agent-agent_002_04",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_002_04",
        "title": "@regression Regression verifies guarded write flow after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: GitNexus MCP evidence (file_neighbors) identifies mutation or lifecycle impact.]",
        "displayTitle": "Regression verifies guarded write flow after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 15
      },
      {
        "id": "AGENT_002_01",
        "title": "@bvt BVT verifies security remains reachable after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Sign in to Admin. | Open the impacted application shell or screen related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Assert the shell renders without auth, permission, or crash failures.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: GitNexus MCP evidence (file_neighbors) identifies this as critical impact.]",
        "displayTitle": "BVT verifies security remains reachable after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 11
      },
      {
        "id": "AGENT_002_02",
        "title": "@sanity Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (file_neighbors) links the change to this feature path.]",
        "displayTitle": "Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 11
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_002_04 covers this Mutation scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression verifies guarded write flow after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: GitNexus MCP evidence (file_neighbors) identifies mutation or lifecycle impact.]"
  },
  {
    "id": "AGENT_002_05",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Security regression for Admin",
    "testCase": "Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open a downstream Admin workflow connected to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.",
    "expected": "Connected downstream behavior remains stable after the code change.",
    "risk": "High",
    "sourcePath": "apps/admin/src/components/AdminCreateAccessRecordModal.tsx",
    "surfaceLabel": "Admin",
    "feature": "Security",
    "adminScreen": "Permissions",
    "graphSource": "gitnexus-mcp",
    "graphEvidence": "file_neighbors",
    "gitNexus": {
      "path": "apps/admin/src/components/AdminCreateAccessRecordModal.tsx",
      "area": "Admin",
      "risk": "High",
      "tools": [
        "cypher"
      ],
      "neighborhood": "{\n  \"markdown\": \"| labels | name | filePath | relation |\\n| --- | --- | --- | --- |\\n| Const | AdminCreateAccessRecordModal | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | principalOptions | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | parsedErrors | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | objectError | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | principalError | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Const | summaryMessages | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Folder | components | apps/admin/src/components | CONTAINS |\\n| Function | AdminCreateAccessRecordModal | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Function | parsedErrors | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| Function | summaryMessages | apps/admin/src/components/AdminCreateAccessRecordModal.tsx | DEFINES |\\n| File | accessPermissions.ts | apps/admin/src/accessPermissions.ts | IMPORTS |\\n| File | dialogErrors.ts | apps/admin/src/components/dialogErrors.ts | IMPORTS |\\n| File | AttachmentAccessEditor.tsx | apps/admin/src/components/AttachmentAccessEditor.tsx | IMPORTS |\\n| File | AdminAccessControlsPanel.tsx | apps/admin/src/components/AdminAccessControlsPanel.tsx | IMPORTS |\\n| File | AccessPermissionHelp.tsx | apps/admin/src/components/AccessPermissionHelp.tsx | IMPORTS |\\n| File | AccessFieldPermissionsEditor.tsx | apps/admin/src/components/AccessFieldPermissionsEditor.tsx | IMPORTS |\",\n  \"row_count\": 16\n}\n\n---\n**Next:** To explore a result symbol, use context({name: \"<name>\", repo: \"core-platform\"}). For schema reference, READ gitnexus://repo/core-platform/schema."
    },
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Regression",
    "level": "Regression",
    "tag": "@regression",
    "proof": "GitNexus MCP evidence (file_neighbors) provides downstream relationship context.",
    "evidenceName": "agent-agent_002_05",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_002_05",
        "title": "@regression Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (file_neighbors) provides downstream relationship context.]",
        "displayTitle": "Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 14
      },
      {
        "id": "AGENT_001_03",
        "title": "@regression Regression protects downstream validation behavior after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminConfirmModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Regression protects downstream validation behavior after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 12
      },
      {
        "id": "AGENT_002_04",
        "title": "@regression Regression verifies guarded write flow after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: GitNexus MCP evidence (file_neighbors) identifies mutation or lifecycle impact.]",
        "displayTitle": "Regression verifies guarded write flow after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 12
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_002_05 covers this Regression scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (file_neighbors) provides downstream relationship context.]"
  },
  {
    "id": "AGENT_003_01",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Admin regression for Admin",
    "testCase": "Sanity verifies validation happy path after AdminFieldModal.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminFieldModal.tsx. | Capture evidence after the happy path completes.",
    "expected": "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    "risk": "Low",
    "sourcePath": "apps/admin/src/components/AdminFieldModal.tsx",
    "surfaceLabel": "Admin",
    "feature": "Validation",
    "adminScreen": "Objects",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Sanity",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Focused sanity coverage for apps/admin/src/components/AdminFieldModal.tsx.",
    "evidenceName": "agent-agent_003_01",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_003_01",
        "title": "@sanity Sanity verifies validation happy path after AdminFieldModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminFieldModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/components/AdminFieldModal.tsx.]",
        "displayTitle": "Sanity verifies validation happy path after AdminFieldModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 14
      },
      {
        "id": "AGENT_001_01",
        "title": "@sanity Sanity verifies validation happy path after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminConfirmModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Sanity verifies validation happy path after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 13
      },
      {
        "id": "AGENT_002_02",
        "title": "@sanity Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (file_neighbors) links the change to this feature path.]",
        "displayTitle": "Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 12
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_003_01 covers this Sanity scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Sanity verifies validation happy path after AdminFieldModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminFieldModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/components/AdminFieldModal.tsx.]"
  },
  {
    "id": "AGENT_003_02",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Admin regression for Admin",
    "testCase": "Validation checks guarded behavior after AdminFieldModal.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted Admin feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.",
    "expected": "Invalid or unauthorized input is rejected with a safe error state and no crash.",
    "risk": "Low",
    "sourcePath": "apps/admin/src/components/AdminFieldModal.tsx",
    "surfaceLabel": "Admin",
    "feature": "Validation",
    "adminScreen": "Objects",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Validation",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Guarded behavior coverage for apps/admin/src/components/AdminFieldModal.tsx.",
    "evidenceName": "agent-agent_003_02",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_003_02",
        "title": "@sanity Validation checks guarded behavior after AdminFieldModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/admin/src/components/AdminFieldModal.tsx.]",
        "displayTitle": "Validation checks guarded behavior after AdminFieldModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 13
      },
      {
        "id": "AGENT_001_02",
        "title": "@sanity Validation checks guarded behavior after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Validation checks guarded behavior after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 12
      },
      {
        "id": "AGENT_003_03",
        "title": "@regression Regression protects downstream validation behavior after AdminFieldModal.tsx [surface: Admin] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminFieldModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/components/AdminFieldModal.tsx.]",
        "displayTitle": "Regression protects downstream validation behavior after AdminFieldModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 11
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_003_02 covers this Validation scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Validation checks guarded behavior after AdminFieldModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/admin/src/components/AdminFieldModal.tsx.]"
  },
  {
    "id": "AGENT_003_03",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Admin regression for Admin",
    "testCase": "Regression protects downstream validation behavior after AdminFieldModal.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open a downstream Admin workflow connected to apps/admin/src/components/AdminFieldModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.",
    "expected": "Connected downstream behavior remains stable after the code change.",
    "risk": "Low",
    "sourcePath": "apps/admin/src/components/AdminFieldModal.tsx",
    "surfaceLabel": "Admin",
    "feature": "Validation",
    "adminScreen": "Objects",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Regression",
    "level": "Regression",
    "tag": "@regression",
    "proof": "Downstream regression coverage for apps/admin/src/components/AdminFieldModal.tsx.",
    "evidenceName": "agent-agent_003_03",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_003_03",
        "title": "@regression Regression protects downstream validation behavior after AdminFieldModal.tsx [surface: Admin] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminFieldModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/components/AdminFieldModal.tsx.]",
        "displayTitle": "Regression protects downstream validation behavior after AdminFieldModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 14
      },
      {
        "id": "AGENT_001_03",
        "title": "@regression Regression protects downstream validation behavior after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminConfirmModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Regression protects downstream validation behavior after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 13
      },
      {
        "id": "AGENT_002_05",
        "title": "@regression Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (file_neighbors) provides downstream relationship context.]",
        "displayTitle": "Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 12
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_003_03 covers this Regression scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression protects downstream validation behavior after AdminFieldModal.tsx [surface: Admin] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminFieldModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/components/AdminFieldModal.tsx.]"
  },
  {
    "id": "AGENT_004_01",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Admin regression for Admin",
    "testCase": "Sanity verifies metadata and records happy path after AdminObjectHomePanel.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminObjectHomePanel.tsx. | Capture evidence after the happy path completes.",
    "expected": "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    "risk": "Low",
    "sourcePath": "apps/admin/src/components/AdminObjectHomePanel.tsx",
    "surfaceLabel": "Admin",
    "feature": "Metadata and records",
    "adminScreen": "Objects",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Sanity",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Focused sanity coverage for apps/admin/src/components/AdminObjectHomePanel.tsx.",
    "evidenceName": "agent-agent_004_01",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_004_01",
        "title": "@sanity Sanity verifies metadata and records happy path after AdminObjectHomePanel.tsx [surface: Admin] [feature: Metadata and records] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminObjectHomePanel.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/components/AdminObjectHomePanel.tsx.]",
        "displayTitle": "Sanity verifies metadata and records happy path after AdminObjectHomePanel.tsx",
        "surface": "Admin",
        "feature": "Metadata and records",
        "score": 16
      },
      {
        "id": "AGENT_001_01",
        "title": "@sanity Sanity verifies validation happy path after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminConfirmModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Sanity verifies validation happy path after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 13
      },
      {
        "id": "AGENT_002_02",
        "title": "@sanity Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (file_neighbors) links the change to this feature path.]",
        "displayTitle": "Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_004_01 covers this Sanity scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Sanity verifies metadata and records happy path after AdminObjectHomePanel.tsx [surface: Admin] [feature: Metadata and records] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminObjectHomePanel.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/components/AdminObjectHomePanel.tsx.]"
  },
  {
    "id": "AGENT_004_02",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Admin regression for Admin",
    "testCase": "Regression protects downstream metadata and records behavior after AdminObjectHomePanel.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open a downstream Admin workflow connected to apps/admin/src/components/AdminObjectHomePanel.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.",
    "expected": "Connected downstream behavior remains stable after the code change.",
    "risk": "Low",
    "sourcePath": "apps/admin/src/components/AdminObjectHomePanel.tsx",
    "surfaceLabel": "Admin",
    "feature": "Metadata and records",
    "adminScreen": "Objects",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Regression",
    "level": "Regression",
    "tag": "@regression",
    "proof": "Downstream regression coverage for apps/admin/src/components/AdminObjectHomePanel.tsx.",
    "evidenceName": "agent-agent_004_02",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_004_02",
        "title": "@regression Regression protects downstream metadata and records behavior after AdminObjectHomePanel.tsx [surface: Admin] [feature: Metadata and records] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminObjectHomePanel.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/components/AdminObjectHomePanel.tsx.]",
        "displayTitle": "Regression protects downstream metadata and records behavior after AdminObjectHomePanel.tsx",
        "surface": "Admin",
        "feature": "Metadata and records",
        "score": 16
      },
      {
        "id": "AGENT_001_03",
        "title": "@regression Regression protects downstream validation behavior after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminConfirmModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Regression protects downstream validation behavior after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 13
      },
      {
        "id": "AGENT_002_05",
        "title": "@regression Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (file_neighbors) provides downstream relationship context.]",
        "displayTitle": "Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_004_02 covers this Regression scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression protects downstream metadata and records behavior after AdminObjectHomePanel.tsx [surface: Admin] [feature: Metadata and records] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminObjectHomePanel.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/components/AdminObjectHomePanel.tsx.]"
  },
  {
    "id": "AGENT_005_01",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Security regression for Admin",
    "testCase": "BVT verifies security remains reachable after useAdminAccessControls.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Sign in to Admin. | Open the impacted application shell or screen related to apps/admin/src/hooks/useAdminAccessControls.ts. | Assert the shell renders without auth, permission, or crash failures.",
    "expected": "The critical impacted surface remains reachable and authenticated behavior is intact.",
    "risk": "High",
    "sourcePath": "apps/admin/src/hooks/useAdminAccessControls.ts",
    "surfaceLabel": "Admin",
    "feature": "Security",
    "adminScreen": "Permissions",
    "graphSource": "gitnexus-mcp",
    "graphEvidence": "file_neighbors",
    "gitNexus": {
      "path": "apps/admin/src/hooks/useAdminAccessControls.ts",
      "area": "Admin",
      "risk": "High",
      "tools": [
        "cypher"
      ],
      "neighborhood": "{\n  \"markdown\": \"| labels | name | filePath | relation |\\n| --- | --- | --- | --- |\\n| File | api.ts | apps/admin/src/api.ts | IMPORTS |\\n| File | accessPermissions.ts | apps/admin/src/accessPermissions.ts | IMPORTS |\\n| Folder | hooks | apps/admin/src/hooks | CONTAINS |\\n| Const | useAdminAccessControls | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | clearMissingAccessRecordSelection | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | next | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | active | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | missingIds | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | cancelled | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | openIds | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | accessRecordPermissionsDirty | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | base | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | objectDirty | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | attachmentDirty | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | fieldDirty | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | openAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | closeAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | accessRecordTabItems | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | items | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | record | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | objectLabel | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | openCreateAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | submitCreateAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | validationErrors | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | fieldPermissions | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | created | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | handleSaveAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | permissions_json | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | updatedRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | resetAccessRecordPermissions | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\",\n  \"row_count\": 30\n}\n\n---\n**Next:** To explore a result symbol, use context({name: \"<name>\", repo: \"core-platform\"}). For schema reference, READ gitnexus://repo/core-platform/schema."
    },
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "BVT",
    "level": "BVT",
    "tag": "@bvt",
    "proof": "GitNexus MCP evidence (file_neighbors) identifies this as critical impact.",
    "evidenceName": "agent-agent_005_01",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_005_01",
        "title": "@bvt BVT verifies security remains reachable after useAdminAccessControls.ts [surface: Admin] [feature: Security] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Sign in to Admin. | Open the impacted application shell or screen related to apps/admin/src/hooks/useAdminAccessControls.ts. | Assert the shell renders without auth, permission, or crash failures.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: GitNexus MCP evidence (file_neighbors) identifies this as critical impact.]",
        "displayTitle": "BVT verifies security remains reachable after useAdminAccessControls.ts",
        "surface": "Admin",
        "feature": "Security",
        "score": 13
      },
      {
        "id": "AGENT_002_01",
        "title": "@bvt BVT verifies security remains reachable after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Sign in to Admin. | Open the impacted application shell or screen related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Assert the shell renders without auth, permission, or crash failures.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: GitNexus MCP evidence (file_neighbors) identifies this as critical impact.]",
        "displayTitle": "BVT verifies security remains reachable after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 11
      },
      {
        "id": "AGENT_005_02",
        "title": "@sanity Sanity verifies security happy path after useAdminAccessControls.ts [surface: Admin] [feature: Security] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/hooks/useAdminAccessControls.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (file_neighbors) links the change to this feature path.]",
        "displayTitle": "Sanity verifies security happy path after useAdminAccessControls.ts",
        "surface": "Admin",
        "feature": "Security",
        "score": 10
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_005_01 covers this BVT scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@bvt BVT verifies security remains reachable after useAdminAccessControls.ts [surface: Admin] [feature: Security] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Sign in to Admin. | Open the impacted application shell or screen related to apps/admin/src/hooks/useAdminAccessControls.ts. | Assert the shell renders without auth, permission, or crash failures.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: GitNexus MCP evidence (file_neighbors) identifies this as critical impact.]"
  },
  {
    "id": "AGENT_005_02",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Security regression for Admin",
    "testCase": "Sanity verifies security happy path after useAdminAccessControls.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/hooks/useAdminAccessControls.ts. | Capture evidence after the happy path completes.",
    "expected": "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    "risk": "High",
    "sourcePath": "apps/admin/src/hooks/useAdminAccessControls.ts",
    "surfaceLabel": "Admin",
    "feature": "Security",
    "adminScreen": "Permissions",
    "graphSource": "gitnexus-mcp",
    "graphEvidence": "file_neighbors",
    "gitNexus": {
      "path": "apps/admin/src/hooks/useAdminAccessControls.ts",
      "area": "Admin",
      "risk": "High",
      "tools": [
        "cypher"
      ],
      "neighborhood": "{\n  \"markdown\": \"| labels | name | filePath | relation |\\n| --- | --- | --- | --- |\\n| File | api.ts | apps/admin/src/api.ts | IMPORTS |\\n| File | accessPermissions.ts | apps/admin/src/accessPermissions.ts | IMPORTS |\\n| Folder | hooks | apps/admin/src/hooks | CONTAINS |\\n| Const | useAdminAccessControls | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | clearMissingAccessRecordSelection | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | next | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | active | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | missingIds | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | cancelled | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | openIds | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | accessRecordPermissionsDirty | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | base | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | objectDirty | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | attachmentDirty | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | fieldDirty | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | openAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | closeAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | accessRecordTabItems | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | items | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | record | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | objectLabel | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | openCreateAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | submitCreateAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | validationErrors | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | fieldPermissions | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | created | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | handleSaveAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | permissions_json | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | updatedRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | resetAccessRecordPermissions | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\",\n  \"row_count\": 30\n}\n\n---\n**Next:** To explore a result symbol, use context({name: \"<name>\", repo: \"core-platform\"}). For schema reference, READ gitnexus://repo/core-platform/schema."
    },
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Sanity",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "GitNexus MCP evidence (file_neighbors) links the change to this feature path.",
    "evidenceName": "agent-agent_005_02",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_005_02",
        "title": "@sanity Sanity verifies security happy path after useAdminAccessControls.ts [surface: Admin] [feature: Security] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/hooks/useAdminAccessControls.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (file_neighbors) links the change to this feature path.]",
        "displayTitle": "Sanity verifies security happy path after useAdminAccessControls.ts",
        "surface": "Admin",
        "feature": "Security",
        "score": 13
      },
      {
        "id": "AGENT_002_02",
        "title": "@sanity Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (file_neighbors) links the change to this feature path.]",
        "displayTitle": "Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 11
      },
      {
        "id": "AGENT_001_01",
        "title": "@sanity Sanity verifies validation happy path after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminConfirmModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Sanity verifies validation happy path after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 10
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_005_02 covers this Sanity scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Sanity verifies security happy path after useAdminAccessControls.ts [surface: Admin] [feature: Security] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/hooks/useAdminAccessControls.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (file_neighbors) links the change to this feature path.]"
  },
  {
    "id": "AGENT_005_03",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Security regression for Admin",
    "testCase": "Security checks guarded behavior after useAdminAccessControls.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted Admin feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.",
    "expected": "Invalid or unauthorized input is rejected with a safe error state and no crash.",
    "risk": "High",
    "sourcePath": "apps/admin/src/hooks/useAdminAccessControls.ts",
    "surfaceLabel": "Admin",
    "feature": "Security",
    "adminScreen": "Permissions",
    "graphSource": "gitnexus-mcp",
    "graphEvidence": "file_neighbors",
    "gitNexus": {
      "path": "apps/admin/src/hooks/useAdminAccessControls.ts",
      "area": "Admin",
      "risk": "High",
      "tools": [
        "cypher"
      ],
      "neighborhood": "{\n  \"markdown\": \"| labels | name | filePath | relation |\\n| --- | --- | --- | --- |\\n| File | api.ts | apps/admin/src/api.ts | IMPORTS |\\n| File | accessPermissions.ts | apps/admin/src/accessPermissions.ts | IMPORTS |\\n| Folder | hooks | apps/admin/src/hooks | CONTAINS |\\n| Const | useAdminAccessControls | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | clearMissingAccessRecordSelection | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | next | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | active | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | missingIds | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | cancelled | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | openIds | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | accessRecordPermissionsDirty | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | base | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | objectDirty | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | attachmentDirty | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | fieldDirty | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | openAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | closeAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | accessRecordTabItems | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | items | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | record | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | objectLabel | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | openCreateAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | submitCreateAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | validationErrors | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | fieldPermissions | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | created | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | handleSaveAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | permissions_json | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | updatedRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | resetAccessRecordPermissions | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\",\n  \"row_count\": 30\n}\n\n---\n**Next:** To explore a result symbol, use context({name: \"<name>\", repo: \"core-platform\"}). For schema reference, READ gitnexus://repo/core-platform/schema."
    },
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Security",
    "level": "BVT",
    "tag": "@bvt",
    "proof": "GitNexus MCP evidence (file_neighbors) indicates guarded logic impact.",
    "evidenceName": "agent-agent_005_03",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_005_01",
        "title": "@bvt BVT verifies security remains reachable after useAdminAccessControls.ts [surface: Admin] [feature: Security] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Sign in to Admin. | Open the impacted application shell or screen related to apps/admin/src/hooks/useAdminAccessControls.ts. | Assert the shell renders without auth, permission, or crash failures.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: GitNexus MCP evidence (file_neighbors) identifies this as critical impact.]",
        "displayTitle": "BVT verifies security remains reachable after useAdminAccessControls.ts",
        "surface": "Admin",
        "feature": "Security",
        "score": 10
      },
      {
        "id": "AGENT_005_04",
        "title": "@regression Regression protects downstream security behavior after useAdminAccessControls.ts [surface: Admin] [feature: Security] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/hooks/useAdminAccessControls.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (file_neighbors) provides downstream relationship context.]",
        "displayTitle": "Regression protects downstream security behavior after useAdminAccessControls.ts",
        "surface": "Admin",
        "feature": "Security",
        "score": 10
      },
      {
        "id": "AGENT_001_02",
        "title": "@sanity Validation checks guarded behavior after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Validation checks guarded behavior after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 9
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_005_01 covers this Security scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@bvt Security checks guarded behavior after useAdminAccessControls.ts [surface: Admin] [feature: Security] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: GitNexus MCP evidence (file_neighbors) indicates guarded logic impact.]"
  },
  {
    "id": "AGENT_005_04",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Security regression for Admin",
    "testCase": "Regression protects downstream security behavior after useAdminAccessControls.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open a downstream Admin workflow connected to apps/admin/src/hooks/useAdminAccessControls.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.",
    "expected": "Connected downstream behavior remains stable after the code change.",
    "risk": "High",
    "sourcePath": "apps/admin/src/hooks/useAdminAccessControls.ts",
    "surfaceLabel": "Admin",
    "feature": "Security",
    "adminScreen": "Permissions",
    "graphSource": "gitnexus-mcp",
    "graphEvidence": "file_neighbors",
    "gitNexus": {
      "path": "apps/admin/src/hooks/useAdminAccessControls.ts",
      "area": "Admin",
      "risk": "High",
      "tools": [
        "cypher"
      ],
      "neighborhood": "{\n  \"markdown\": \"| labels | name | filePath | relation |\\n| --- | --- | --- | --- |\\n| File | api.ts | apps/admin/src/api.ts | IMPORTS |\\n| File | accessPermissions.ts | apps/admin/src/accessPermissions.ts | IMPORTS |\\n| Folder | hooks | apps/admin/src/hooks | CONTAINS |\\n| Const | useAdminAccessControls | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | clearMissingAccessRecordSelection | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | next | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | active | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | missingIds | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | cancelled | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | openIds | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | accessRecordPermissionsDirty | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | base | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | objectDirty | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | attachmentDirty | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | fieldDirty | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | openAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | closeAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | accessRecordTabItems | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | items | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | record | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | objectLabel | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | openCreateAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | submitCreateAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | validationErrors | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | fieldPermissions | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | created | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | handleSaveAccessRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | permissions_json | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | updatedRecord | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\\n| Const | resetAccessRecordPermissions | apps/admin/src/hooks/useAdminAccessControls.ts | DEFINES |\",\n  \"row_count\": 30\n}\n\n---\n**Next:** To explore a result symbol, use context({name: \"<name>\", repo: \"core-platform\"}). For schema reference, READ gitnexus://repo/core-platform/schema."
    },
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Regression",
    "level": "Regression",
    "tag": "@regression",
    "proof": "GitNexus MCP evidence (file_neighbors) provides downstream relationship context.",
    "evidenceName": "agent-agent_005_04",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_005_04",
        "title": "@regression Regression protects downstream security behavior after useAdminAccessControls.ts [surface: Admin] [feature: Security] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/hooks/useAdminAccessControls.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (file_neighbors) provides downstream relationship context.]",
        "displayTitle": "Regression protects downstream security behavior after useAdminAccessControls.ts",
        "surface": "Admin",
        "feature": "Security",
        "score": 13
      },
      {
        "id": "AGENT_002_05",
        "title": "@regression Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (file_neighbors) provides downstream relationship context.]",
        "displayTitle": "Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 11
      },
      {
        "id": "AGENT_001_03",
        "title": "@regression Regression protects downstream validation behavior after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminConfirmModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Regression protects downstream validation behavior after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 10
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_005_04 covers this Regression scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression protects downstream security behavior after useAdminAccessControls.ts [surface: Admin] [feature: Security] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/hooks/useAdminAccessControls.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (file_neighbors) provides downstream relationship context.]"
  },
  {
    "id": "AGENT_006_01",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Admin regression for Admin",
    "testCase": "Sanity verifies admin happy path after main.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/main.tsx. | Capture evidence after the happy path completes.",
    "expected": "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    "risk": "Low",
    "sourcePath": "apps/admin/src/main.tsx",
    "surfaceLabel": "Admin",
    "feature": "Admin",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Sanity",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Focused sanity coverage for apps/admin/src/main.tsx.",
    "evidenceName": "agent-agent_006_01",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_006_01",
        "title": "@sanity Sanity verifies admin happy path after main.tsx [surface: Admin] [feature: Admin] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/main.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/main.tsx.]",
        "displayTitle": "Sanity verifies admin happy path after main.tsx",
        "surface": "Admin",
        "feature": "Admin",
        "score": 12
      },
      {
        "id": "AGENT_001_01",
        "title": "@sanity Sanity verifies validation happy path after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminConfirmModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Sanity verifies validation happy path after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 11
      },
      {
        "id": "AGENT_002_02",
        "title": "@sanity Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (file_neighbors) links the change to this feature path.]",
        "displayTitle": "Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 11
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_006_01 covers this Sanity scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Sanity verifies admin happy path after main.tsx [surface: Admin] [feature: Admin] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/main.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/main.tsx.]"
  },
  {
    "id": "AGENT_006_02",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Admin regression for Admin",
    "testCase": "Regression protects downstream admin behavior after main.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open a downstream Admin workflow connected to apps/admin/src/main.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.",
    "expected": "Connected downstream behavior remains stable after the code change.",
    "risk": "Low",
    "sourcePath": "apps/admin/src/main.tsx",
    "surfaceLabel": "Admin",
    "feature": "Admin",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Regression",
    "level": "Regression",
    "tag": "@regression",
    "proof": "Downstream regression coverage for apps/admin/src/main.tsx.",
    "evidenceName": "agent-agent_006_02",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_006_02",
        "title": "@regression Regression protects downstream admin behavior after main.tsx [surface: Admin] [feature: Admin] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/main.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/main.tsx.]",
        "displayTitle": "Regression protects downstream admin behavior after main.tsx",
        "surface": "Admin",
        "feature": "Admin",
        "score": 12
      },
      {
        "id": "AGENT_001_03",
        "title": "@regression Regression protects downstream validation behavior after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminConfirmModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Regression protects downstream validation behavior after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 11
      },
      {
        "id": "AGENT_002_05",
        "title": "@regression Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (file_neighbors) provides downstream relationship context.]",
        "displayTitle": "Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 11
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_006_02 covers this Regression scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression protects downstream admin behavior after main.tsx [surface: Admin] [feature: Admin] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/main.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/main.tsx.]"
  },
  {
    "id": "AGENT_007_01",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Admin regression for Admin",
    "testCase": "Sanity verifies application ui happy path after style.css",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/style.css. | Capture evidence after the happy path completes.",
    "expected": "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    "risk": "Low",
    "sourcePath": "apps/admin/src/style.css",
    "surfaceLabel": "Admin",
    "feature": "Application UI",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Sanity",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Focused sanity coverage for apps/admin/src/style.css.",
    "evidenceName": "agent-agent_007_01",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_007_01",
        "title": "@sanity Sanity verifies application ui happy path after style.css [surface: Admin] [feature: Application UI] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/style.css. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/style.css.]",
        "displayTitle": "Sanity verifies application ui happy path after style.css",
        "surface": "Admin",
        "feature": "Application UI",
        "score": 13
      },
      {
        "id": "AGENT_001_01",
        "title": "@sanity Sanity verifies validation happy path after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminConfirmModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Sanity verifies validation happy path after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 10
      },
      {
        "id": "AGENT_002_02",
        "title": "@sanity Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (file_neighbors) links the change to this feature path.]",
        "displayTitle": "Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 10
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_007_01 covers this Sanity scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Sanity verifies application ui happy path after style.css [surface: Admin] [feature: Application UI] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/style.css. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/style.css.]"
  },
  {
    "id": "AGENT_007_02",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Admin regression for Admin",
    "testCase": "Regression protects downstream application ui behavior after style.css",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open a downstream Admin workflow connected to apps/admin/src/style.css. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.",
    "expected": "Connected downstream behavior remains stable after the code change.",
    "risk": "Low",
    "sourcePath": "apps/admin/src/style.css",
    "surfaceLabel": "Admin",
    "feature": "Application UI",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Regression",
    "level": "Regression",
    "tag": "@regression",
    "proof": "Downstream regression coverage for apps/admin/src/style.css.",
    "evidenceName": "agent-agent_007_02",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_007_02",
        "title": "@regression Regression protects downstream application ui behavior after style.css [surface: Admin] [feature: Application UI] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/style.css. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/style.css.]",
        "displayTitle": "Regression protects downstream application ui behavior after style.css",
        "surface": "Admin",
        "feature": "Application UI",
        "score": 13
      },
      {
        "id": "AGENT_001_03",
        "title": "@regression Regression protects downstream validation behavior after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminConfirmModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Regression protects downstream validation behavior after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 10
      },
      {
        "id": "AGENT_002_05",
        "title": "@regression Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (file_neighbors) provides downstream relationship context.]",
        "displayTitle": "Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 10
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_007_02 covers this Regression scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression protects downstream application ui behavior after style.css [surface: Admin] [feature: Application UI] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/style.css. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/style.css.]"
  },
  {
    "id": "AGENT_008_01",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "BVT verifies api contract remains reachable after routes.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Authenticate through the API. | Exercise the route family related to apps/service/src/admin/routes.ts. | Assert a valid authenticated response.",
    "expected": "The critical impacted surface remains reachable and authenticated behavior is intact.",
    "risk": "High",
    "sourcePath": "apps/service/src/admin/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp",
    "graphEvidence": "api_impact, file_neighbors",
    "gitNexus": {
      "path": "apps/service/src/admin/routes.ts",
      "area": "API / Service",
      "risk": "High",
      "tools": [
        "cypher",
        "api_impact"
      ],
      "neighborhood": "[]\n\n---\n**Next:** To explore a result symbol, use context({name: \"<name>\", repo: \"core-platform\"}). For schema reference, READ gitnexus://repo/core-platform/schema.",
      "apiImpact": "{\n  \"error\": \"No routes found matching \\\"apps/service/src/admin/routes.ts\\\".\"\n}"
    },
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "BVT",
    "level": "BVT",
    "tag": "@bvt",
    "proof": "GitNexus MCP evidence (api_impact, file_neighbors) identifies this as critical impact.",
    "evidenceName": "agent-agent_008_01",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_008_01",
        "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/admin/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) identifies this as critical impact.]",
        "displayTitle": "BVT verifies api contract remains reachable after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 14
      },
      {
        "id": "AGENT_009_01",
        "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/apps/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: Critical smoke coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "BVT verifies api contract remains reachable after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_010_01",
        "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/list-views/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: Critical smoke coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "BVT verifies api contract remains reachable after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_008_01 covers this BVT scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/admin/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) identifies this as critical impact.]"
  },
  {
    "id": "AGENT_008_02",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "Sanity verifies api contract happy path after routes.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/admin/routes.ts. | Capture evidence after the happy path completes.",
    "expected": "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    "risk": "High",
    "sourcePath": "apps/service/src/admin/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp",
    "graphEvidence": "api_impact, file_neighbors",
    "gitNexus": {
      "path": "apps/service/src/admin/routes.ts",
      "area": "API / Service",
      "risk": "High",
      "tools": [
        "cypher",
        "api_impact"
      ],
      "neighborhood": "[]\n\n---\n**Next:** To explore a result symbol, use context({name: \"<name>\", repo: \"core-platform\"}). For schema reference, READ gitnexus://repo/core-platform/schema.",
      "apiImpact": "{\n  \"error\": \"No routes found matching \\\"apps/service/src/admin/routes.ts\\\".\"\n}"
    },
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Sanity",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "GitNexus MCP evidence (api_impact, file_neighbors) links the change to this feature path.",
    "evidenceName": "agent-agent_008_02",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_008_02",
        "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/admin/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) links the change to this feature path.]",
        "displayTitle": "Sanity verifies api contract happy path after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 14
      },
      {
        "id": "AGENT_009_02",
        "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/apps/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Sanity verifies api contract happy path after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_010_02",
        "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/list-views/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "Sanity verifies api contract happy path after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_008_02 covers this Sanity scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/admin/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) links the change to this feature path.]"
  },
  {
    "id": "AGENT_008_03",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "Validation checks guarded behavior after routes.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.",
    "expected": "Invalid or unauthorized input is rejected with a safe error state and no crash.",
    "risk": "High",
    "sourcePath": "apps/service/src/admin/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp",
    "graphEvidence": "api_impact, file_neighbors",
    "gitNexus": {
      "path": "apps/service/src/admin/routes.ts",
      "area": "API / Service",
      "risk": "High",
      "tools": [
        "cypher",
        "api_impact"
      ],
      "neighborhood": "[]\n\n---\n**Next:** To explore a result symbol, use context({name: \"<name>\", repo: \"core-platform\"}). For schema reference, READ gitnexus://repo/core-platform/schema.",
      "apiImpact": "{\n  \"error\": \"No routes found matching \\\"apps/service/src/admin/routes.ts\\\".\"\n}"
    },
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Validation",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "GitNexus MCP evidence (api_impact, file_neighbors) indicates guarded logic impact.",
    "evidenceName": "agent-agent_008_03",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_009_03",
        "title": "@sanity Validation checks guarded behavior after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Validation checks guarded behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_010_03",
        "title": "@sanity Validation checks guarded behavior after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "Validation checks guarded behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_011_03",
        "title": "@sanity Validation checks guarded behavior after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/records/routes.ts.]",
        "displayTitle": "Validation checks guarded behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_009_03 covers this Validation scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Validation checks guarded behavior after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) indicates guarded logic impact.]"
  },
  {
    "id": "AGENT_008_04",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "Regression verifies guarded write flow after routes.ts",
    "precondition": "ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.",
    "steps": "Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/admin/routes.ts. | Verify cleanup or reset restores seeded state.",
    "expected": "The write flow works on seeded/disposable data and the reset path can restore the local dataset.",
    "risk": "High",
    "sourcePath": "apps/service/src/admin/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp",
    "graphEvidence": "api_impact, file_neighbors",
    "gitNexus": {
      "path": "apps/service/src/admin/routes.ts",
      "area": "API / Service",
      "risk": "High",
      "tools": [
        "cypher",
        "api_impact"
      ],
      "neighborhood": "[]\n\n---\n**Next:** To explore a result symbol, use context({name: \"<name>\", repo: \"core-platform\"}). For schema reference, READ gitnexus://repo/core-platform/schema.",
      "apiImpact": "{\n  \"error\": \"No routes found matching \\\"apps/service/src/admin/routes.ts\\\".\"\n}"
    },
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": true,
    "scenarioFamily": "Mutation",
    "level": "Regression",
    "tag": "@regression",
    "proof": "GitNexus MCP evidence (api_impact, file_neighbors) identifies mutation or lifecycle impact.",
    "evidenceName": "agent-agent_008_04",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_008_04",
        "title": "@regression Regression verifies guarded write flow after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/admin/routes.ts. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) identifies mutation or lifecycle impact.]",
        "displayTitle": "Regression verifies guarded write flow after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 15
      },
      {
        "id": "AGENT_009_04",
        "title": "@regression Regression verifies guarded write flow after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/apps/routes.ts. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: Guarded mutation regression coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Regression verifies guarded write flow after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 14
      },
      {
        "id": "AGENT_010_04",
        "title": "@regression Regression verifies guarded write flow after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/list-views/routes.ts. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: Guarded mutation regression coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "Regression verifies guarded write flow after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 14
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_008_04 covers this Mutation scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression verifies guarded write flow after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/admin/routes.ts. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) identifies mutation or lifecycle impact.]"
  },
  {
    "id": "AGENT_008_05",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "Regression protects downstream api contract behavior after routes.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open a downstream API workflow connected to apps/service/src/admin/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.",
    "expected": "Connected downstream behavior remains stable after the code change.",
    "risk": "High",
    "sourcePath": "apps/service/src/admin/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp",
    "graphEvidence": "api_impact, file_neighbors",
    "gitNexus": {
      "path": "apps/service/src/admin/routes.ts",
      "area": "API / Service",
      "risk": "High",
      "tools": [
        "cypher",
        "api_impact"
      ],
      "neighborhood": "[]\n\n---\n**Next:** To explore a result symbol, use context({name: \"<name>\", repo: \"core-platform\"}). For schema reference, READ gitnexus://repo/core-platform/schema.",
      "apiImpact": "{\n  \"error\": \"No routes found matching \\\"apps/service/src/admin/routes.ts\\\".\"\n}"
    },
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Regression",
    "level": "Regression",
    "tag": "@regression",
    "proof": "GitNexus MCP evidence (api_impact, file_neighbors) provides downstream relationship context.",
    "evidenceName": "agent-agent_008_05",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_008_05",
        "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/admin/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) provides downstream relationship context.]",
        "displayTitle": "Regression protects downstream api contract behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 14
      },
      {
        "id": "AGENT_009_05",
        "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/apps/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Regression protects downstream api contract behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_010_05",
        "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/list-views/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "Regression protects downstream api contract behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_008_05 covers this Regression scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/admin/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) provides downstream relationship context.]"
  },
  {
    "id": "AGENT_009_01",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "BVT verifies api contract remains reachable after routes.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Authenticate through the API. | Exercise the route family related to apps/service/src/apps/routes.ts. | Assert a valid authenticated response.",
    "expected": "The critical impacted surface remains reachable and authenticated behavior is intact.",
    "risk": "High",
    "sourcePath": "apps/service/src/apps/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "BVT",
    "level": "BVT",
    "tag": "@bvt",
    "proof": "Critical smoke coverage for apps/service/src/apps/routes.ts.",
    "evidenceName": "agent-agent_009_01",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_008_01",
        "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/admin/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) identifies this as critical impact.]",
        "displayTitle": "BVT verifies api contract remains reachable after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_009_01",
        "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/apps/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: Critical smoke coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "BVT verifies api contract remains reachable after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_010_01",
        "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/list-views/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: Critical smoke coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "BVT verifies api contract remains reachable after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_008_01 covers this BVT scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/apps/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: Critical smoke coverage for apps/service/src/apps/routes.ts.]"
  },
  {
    "id": "AGENT_009_02",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "Sanity verifies api contract happy path after routes.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/apps/routes.ts. | Capture evidence after the happy path completes.",
    "expected": "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    "risk": "High",
    "sourcePath": "apps/service/src/apps/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Sanity",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Focused sanity coverage for apps/service/src/apps/routes.ts.",
    "evidenceName": "agent-agent_009_02",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_008_02",
        "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/admin/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) links the change to this feature path.]",
        "displayTitle": "Sanity verifies api contract happy path after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_009_02",
        "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/apps/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Sanity verifies api contract happy path after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_010_02",
        "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/list-views/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "Sanity verifies api contract happy path after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_008_02 covers this Sanity scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/apps/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/service/src/apps/routes.ts.]"
  },
  {
    "id": "AGENT_009_03",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "Validation checks guarded behavior after routes.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.",
    "expected": "Invalid or unauthorized input is rejected with a safe error state and no crash.",
    "risk": "High",
    "sourcePath": "apps/service/src/apps/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Validation",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Guarded behavior coverage for apps/service/src/apps/routes.ts.",
    "evidenceName": "agent-agent_009_03",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_009_03",
        "title": "@sanity Validation checks guarded behavior after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Validation checks guarded behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_010_03",
        "title": "@sanity Validation checks guarded behavior after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "Validation checks guarded behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_011_03",
        "title": "@sanity Validation checks guarded behavior after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/records/routes.ts.]",
        "displayTitle": "Validation checks guarded behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_009_03 covers this Validation scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Validation checks guarded behavior after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/apps/routes.ts.]"
  },
  {
    "id": "AGENT_009_04",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "Regression verifies guarded write flow after routes.ts",
    "precondition": "ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.",
    "steps": "Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/apps/routes.ts. | Verify cleanup or reset restores seeded state.",
    "expected": "The write flow works on seeded/disposable data and the reset path can restore the local dataset.",
    "risk": "High",
    "sourcePath": "apps/service/src/apps/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": true,
    "scenarioFamily": "Mutation",
    "level": "Regression",
    "tag": "@regression",
    "proof": "Guarded mutation regression coverage for apps/service/src/apps/routes.ts.",
    "evidenceName": "agent-agent_009_04",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_008_04",
        "title": "@regression Regression verifies guarded write flow after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/admin/routes.ts. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) identifies mutation or lifecycle impact.]",
        "displayTitle": "Regression verifies guarded write flow after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 14
      },
      {
        "id": "AGENT_009_04",
        "title": "@regression Regression verifies guarded write flow after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/apps/routes.ts. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: Guarded mutation regression coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Regression verifies guarded write flow after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 14
      },
      {
        "id": "AGENT_010_04",
        "title": "@regression Regression verifies guarded write flow after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/list-views/routes.ts. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: Guarded mutation regression coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "Regression verifies guarded write flow after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 14
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_008_04 covers this Mutation scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression verifies guarded write flow after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/apps/routes.ts. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: Guarded mutation regression coverage for apps/service/src/apps/routes.ts.]"
  },
  {
    "id": "AGENT_009_05",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "Regression protects downstream api contract behavior after routes.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open a downstream API workflow connected to apps/service/src/apps/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.",
    "expected": "Connected downstream behavior remains stable after the code change.",
    "risk": "High",
    "sourcePath": "apps/service/src/apps/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Regression",
    "level": "Regression",
    "tag": "@regression",
    "proof": "Downstream regression coverage for apps/service/src/apps/routes.ts.",
    "evidenceName": "agent-agent_009_05",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_008_05",
        "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/admin/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) provides downstream relationship context.]",
        "displayTitle": "Regression protects downstream api contract behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_009_05",
        "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/apps/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Regression protects downstream api contract behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_010_05",
        "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/list-views/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "Regression protects downstream api contract behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_008_05 covers this Regression scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/apps/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/service/src/apps/routes.ts.]"
  },
  {
    "id": "AGENT_010_01",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "List View regression for API / Service",
    "testCase": "BVT verifies api contract remains reachable after routes.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Authenticate through the API. | Exercise the route family related to apps/service/src/list-views/routes.ts. | Assert a valid authenticated response.",
    "expected": "The critical impacted surface remains reachable and authenticated behavior is intact.",
    "risk": "High",
    "sourcePath": "apps/service/src/list-views/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "BVT",
    "level": "BVT",
    "tag": "@bvt",
    "proof": "Critical smoke coverage for apps/service/src/list-views/routes.ts.",
    "evidenceName": "agent-agent_010_01",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_010_01",
        "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/list-views/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: Critical smoke coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "BVT verifies api contract remains reachable after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 15
      },
      {
        "id": "AGENT_008_01",
        "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/admin/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) identifies this as critical impact.]",
        "displayTitle": "BVT verifies api contract remains reachable after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_009_01",
        "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/apps/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: Critical smoke coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "BVT verifies api contract remains reachable after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_010_01 covers this BVT scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/list-views/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: Critical smoke coverage for apps/service/src/list-views/routes.ts.]"
  },
  {
    "id": "AGENT_010_02",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "List View regression for API / Service",
    "testCase": "Sanity verifies api contract happy path after routes.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/list-views/routes.ts. | Capture evidence after the happy path completes.",
    "expected": "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    "risk": "High",
    "sourcePath": "apps/service/src/list-views/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Sanity",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Focused sanity coverage for apps/service/src/list-views/routes.ts.",
    "evidenceName": "agent-agent_010_02",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_010_02",
        "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/list-views/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "Sanity verifies api contract happy path after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 15
      },
      {
        "id": "AGENT_008_02",
        "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/admin/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) links the change to this feature path.]",
        "displayTitle": "Sanity verifies api contract happy path after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_009_02",
        "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/apps/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Sanity verifies api contract happy path after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_010_02 covers this Sanity scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/list-views/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/service/src/list-views/routes.ts.]"
  },
  {
    "id": "AGENT_010_03",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "List View regression for API / Service",
    "testCase": "Validation checks guarded behavior after routes.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.",
    "expected": "Invalid or unauthorized input is rejected with a safe error state and no crash.",
    "risk": "High",
    "sourcePath": "apps/service/src/list-views/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Validation",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Guarded behavior coverage for apps/service/src/list-views/routes.ts.",
    "evidenceName": "agent-agent_010_03",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_010_03",
        "title": "@sanity Validation checks guarded behavior after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "Validation checks guarded behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 15
      },
      {
        "id": "AGENT_009_03",
        "title": "@sanity Validation checks guarded behavior after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Validation checks guarded behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_010_04",
        "title": "@regression Regression verifies guarded write flow after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/list-views/routes.ts. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: Guarded mutation regression coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "Regression verifies guarded write flow after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_010_03 covers this Validation scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Validation checks guarded behavior after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/list-views/routes.ts.]"
  },
  {
    "id": "AGENT_010_04",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "List View regression for API / Service",
    "testCase": "Regression verifies guarded write flow after routes.ts",
    "precondition": "ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.",
    "steps": "Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/list-views/routes.ts. | Verify cleanup or reset restores seeded state.",
    "expected": "The write flow works on seeded/disposable data and the reset path can restore the local dataset.",
    "risk": "High",
    "sourcePath": "apps/service/src/list-views/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": true,
    "scenarioFamily": "Mutation",
    "level": "Regression",
    "tag": "@regression",
    "proof": "Guarded mutation regression coverage for apps/service/src/list-views/routes.ts.",
    "evidenceName": "agent-agent_010_04",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_010_04",
        "title": "@regression Regression verifies guarded write flow after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/list-views/routes.ts. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: Guarded mutation regression coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "Regression verifies guarded write flow after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 16
      },
      {
        "id": "AGENT_008_04",
        "title": "@regression Regression verifies guarded write flow after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/admin/routes.ts. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) identifies mutation or lifecycle impact.]",
        "displayTitle": "Regression verifies guarded write flow after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 14
      },
      {
        "id": "AGENT_009_04",
        "title": "@regression Regression verifies guarded write flow after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/apps/routes.ts. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: Guarded mutation regression coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Regression verifies guarded write flow after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 14
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_010_04 covers this Mutation scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression verifies guarded write flow after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/list-views/routes.ts. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: Guarded mutation regression coverage for apps/service/src/list-views/routes.ts.]"
  },
  {
    "id": "AGENT_010_05",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "List View regression for API / Service",
    "testCase": "Regression protects downstream api contract behavior after routes.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open a downstream API workflow connected to apps/service/src/list-views/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.",
    "expected": "Connected downstream behavior remains stable after the code change.",
    "risk": "High",
    "sourcePath": "apps/service/src/list-views/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Regression",
    "level": "Regression",
    "tag": "@regression",
    "proof": "Downstream regression coverage for apps/service/src/list-views/routes.ts.",
    "evidenceName": "agent-agent_010_05",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_010_05",
        "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/list-views/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "Regression protects downstream api contract behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 15
      },
      {
        "id": "AGENT_008_05",
        "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/admin/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) provides downstream relationship context.]",
        "displayTitle": "Regression protects downstream api contract behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_009_05",
        "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/apps/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Regression protects downstream api contract behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_010_05 covers this Regression scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/list-views/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/service/src/list-views/routes.ts.]"
  },
  {
    "id": "AGENT_011_01",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "BVT verifies api contract remains reachable after routes.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Authenticate through the API. | Exercise the route family related to apps/service/src/records/routes.ts. | Assert a valid authenticated response.",
    "expected": "The critical impacted surface remains reachable and authenticated behavior is intact.",
    "risk": "High",
    "sourcePath": "apps/service/src/records/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "BVT",
    "level": "BVT",
    "tag": "@bvt",
    "proof": "Critical smoke coverage for apps/service/src/records/routes.ts.",
    "evidenceName": "agent-agent_011_01",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_011_01",
        "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/records/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: Critical smoke coverage for apps/service/src/records/routes.ts.]",
        "displayTitle": "BVT verifies api contract remains reachable after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 14
      },
      {
        "id": "AGENT_008_01",
        "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/admin/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) identifies this as critical impact.]",
        "displayTitle": "BVT verifies api contract remains reachable after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_009_01",
        "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/apps/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: Critical smoke coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "BVT verifies api contract remains reachable after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_011_01 covers this BVT scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/records/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: Critical smoke coverage for apps/service/src/records/routes.ts.]"
  },
  {
    "id": "AGENT_011_02",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "Sanity verifies api contract happy path after routes.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/records/routes.ts. | Capture evidence after the happy path completes.",
    "expected": "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    "risk": "High",
    "sourcePath": "apps/service/src/records/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Sanity",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Focused sanity coverage for apps/service/src/records/routes.ts.",
    "evidenceName": "agent-agent_011_02",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_011_02",
        "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/records/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/service/src/records/routes.ts.]",
        "displayTitle": "Sanity verifies api contract happy path after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 14
      },
      {
        "id": "AGENT_008_02",
        "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/admin/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) links the change to this feature path.]",
        "displayTitle": "Sanity verifies api contract happy path after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_009_02",
        "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/apps/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Sanity verifies api contract happy path after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_011_02 covers this Sanity scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/records/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/service/src/records/routes.ts.]"
  },
  {
    "id": "AGENT_011_03",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "Validation checks guarded behavior after routes.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.",
    "expected": "Invalid or unauthorized input is rejected with a safe error state and no crash.",
    "risk": "High",
    "sourcePath": "apps/service/src/records/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Validation",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Guarded behavior coverage for apps/service/src/records/routes.ts.",
    "evidenceName": "agent-agent_011_03",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_011_03",
        "title": "@sanity Validation checks guarded behavior after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/records/routes.ts.]",
        "displayTitle": "Validation checks guarded behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 14
      },
      {
        "id": "AGENT_009_03",
        "title": "@sanity Validation checks guarded behavior after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Validation checks guarded behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_010_03",
        "title": "@sanity Validation checks guarded behavior after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "Validation checks guarded behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_011_03 covers this Validation scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Validation checks guarded behavior after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/records/routes.ts.]"
  },
  {
    "id": "AGENT_011_04",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "Regression verifies guarded write flow after routes.ts",
    "precondition": "ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.",
    "steps": "Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/records/routes.ts. | Verify cleanup or reset restores seeded state.",
    "expected": "The write flow works on seeded/disposable data and the reset path can restore the local dataset.",
    "risk": "High",
    "sourcePath": "apps/service/src/records/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": true,
    "scenarioFamily": "Mutation",
    "level": "Regression",
    "tag": "@regression",
    "proof": "Guarded mutation regression coverage for apps/service/src/records/routes.ts.",
    "evidenceName": "agent-agent_011_04",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_011_04",
        "title": "@regression Regression verifies guarded write flow after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/records/routes.ts. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: Guarded mutation regression coverage for apps/service/src/records/routes.ts.]",
        "displayTitle": "Regression verifies guarded write flow after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 15
      },
      {
        "id": "AGENT_008_04",
        "title": "@regression Regression verifies guarded write flow after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/admin/routes.ts. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) identifies mutation or lifecycle impact.]",
        "displayTitle": "Regression verifies guarded write flow after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 14
      },
      {
        "id": "AGENT_009_04",
        "title": "@regression Regression verifies guarded write flow after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/apps/routes.ts. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: Guarded mutation regression coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Regression verifies guarded write flow after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 14
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_011_04 covers this Mutation scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression verifies guarded write flow after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: ALLOW_DATA_WRITE=true, seeded test data exists, and reset runs after generated scenarios.] [input: Use seeded or disposable test data. | Exercise create, edit, delete, restore, or bulk behavior related to apps/service/src/records/routes.ts. | Verify cleanup or reset restores seeded state.] [expected: The write flow works on seeded/disposable data and the reset path can restore the local dataset.] [proof: Guarded mutation regression coverage for apps/service/src/records/routes.ts.]"
  },
  {
    "id": "AGENT_011_05",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "Regression protects downstream api contract behavior after routes.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open a downstream API workflow connected to apps/service/src/records/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.",
    "expected": "Connected downstream behavior remains stable after the code change.",
    "risk": "High",
    "sourcePath": "apps/service/src/records/routes.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Regression",
    "level": "Regression",
    "tag": "@regression",
    "proof": "Downstream regression coverage for apps/service/src/records/routes.ts.",
    "evidenceName": "agent-agent_011_05",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_011_05",
        "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/records/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/service/src/records/routes.ts.]",
        "displayTitle": "Regression protects downstream api contract behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 14
      },
      {
        "id": "AGENT_008_05",
        "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/admin/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) provides downstream relationship context.]",
        "displayTitle": "Regression protects downstream api contract behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      },
      {
        "id": "AGENT_009_05",
        "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/apps/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Regression protects downstream api contract behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 13
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_011_05 covers this Regression scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/records/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/service/src/records/routes.ts.]"
  },
  {
    "id": "AGENT_012_01",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "BVT verifies api contract remains reachable after record-jobs.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Authenticate through the API. | Exercise the route family related to apps/service/src/scheduler/record-jobs.ts. | Assert a valid authenticated response.",
    "expected": "The critical impacted surface remains reachable and authenticated behavior is intact.",
    "risk": "Medium",
    "sourcePath": "apps/service/src/scheduler/record-jobs.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "BVT",
    "level": "BVT",
    "tag": "@bvt",
    "proof": "Critical smoke coverage for apps/service/src/scheduler/record-jobs.ts.",
    "evidenceName": "agent-agent_012_01",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_012_01",
        "title": "@bvt BVT verifies api contract remains reachable after record-jobs.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/scheduler/record-jobs.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: Critical smoke coverage for apps/service/src/scheduler/record-jobs.ts.]",
        "displayTitle": "BVT verifies api contract remains reachable after record-jobs.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 15
      },
      {
        "id": "AGENT_008_01",
        "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/admin/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) identifies this as critical impact.]",
        "displayTitle": "BVT verifies api contract remains reachable after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 12
      },
      {
        "id": "AGENT_009_01",
        "title": "@bvt BVT verifies api contract remains reachable after routes.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/apps/routes.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: Critical smoke coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "BVT verifies api contract remains reachable after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 12
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_012_01 covers this BVT scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@bvt BVT verifies api contract remains reachable after record-jobs.ts [surface: API] [feature: API contract] [level: BVT] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Authenticate through the API. | Exercise the route family related to apps/service/src/scheduler/record-jobs.ts. | Assert a valid authenticated response.] [expected: The critical impacted surface remains reachable and authenticated behavior is intact.] [proof: Critical smoke coverage for apps/service/src/scheduler/record-jobs.ts.]"
  },
  {
    "id": "AGENT_012_02",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "Sanity verifies api contract happy path after record-jobs.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/scheduler/record-jobs.ts. | Capture evidence after the happy path completes.",
    "expected": "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    "risk": "Medium",
    "sourcePath": "apps/service/src/scheduler/record-jobs.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Sanity",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Focused sanity coverage for apps/service/src/scheduler/record-jobs.ts.",
    "evidenceName": "agent-agent_012_02",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_012_02",
        "title": "@sanity Sanity verifies api contract happy path after record-jobs.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/scheduler/record-jobs.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/service/src/scheduler/record-jobs.ts.]",
        "displayTitle": "Sanity verifies api contract happy path after record-jobs.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 15
      },
      {
        "id": "AGENT_008_02",
        "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/admin/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) links the change to this feature path.]",
        "displayTitle": "Sanity verifies api contract happy path after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 12
      },
      {
        "id": "AGENT_009_02",
        "title": "@sanity Sanity verifies api contract happy path after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/apps/routes.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Sanity verifies api contract happy path after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 12
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_012_02 covers this Sanity scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Sanity verifies api contract happy path after record-jobs.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Exercise the primary user or API path related to apps/service/src/scheduler/record-jobs.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/service/src/scheduler/record-jobs.ts.]"
  },
  {
    "id": "AGENT_012_03",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "Validation checks guarded behavior after record-jobs.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.",
    "expected": "Invalid or unauthorized input is rejected with a safe error state and no crash.",
    "risk": "Medium",
    "sourcePath": "apps/service/src/scheduler/record-jobs.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Validation",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Guarded behavior coverage for apps/service/src/scheduler/record-jobs.ts.",
    "evidenceName": "agent-agent_012_03",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_012_03",
        "title": "@sanity Validation checks guarded behavior after record-jobs.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/scheduler/record-jobs.ts.]",
        "displayTitle": "Validation checks guarded behavior after record-jobs.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 15
      },
      {
        "id": "AGENT_009_03",
        "title": "@sanity Validation checks guarded behavior after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Validation checks guarded behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 12
      },
      {
        "id": "AGENT_010_03",
        "title": "@sanity Validation checks guarded behavior after routes.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/list-views/routes.ts.]",
        "displayTitle": "Validation checks guarded behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 12
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_012_03 covers this Validation scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Validation checks guarded behavior after record-jobs.ts [surface: API] [feature: API contract] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted API feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/service/src/scheduler/record-jobs.ts.]"
  },
  {
    "id": "AGENT_012_04",
    "suite": "list-view-api",
    "surface": "api",
    "scenario": "API / Service regression for API / Service",
    "testCase": "Regression protects downstream api contract behavior after record-jobs.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open a downstream API workflow connected to apps/service/src/scheduler/record-jobs.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.",
    "expected": "Connected downstream behavior remains stable after the code change.",
    "risk": "Medium",
    "sourcePath": "apps/service/src/scheduler/record-jobs.ts",
    "surfaceLabel": "API",
    "feature": "API contract",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Regression",
    "level": "Regression",
    "tag": "@regression",
    "proof": "Downstream regression coverage for apps/service/src/scheduler/record-jobs.ts.",
    "evidenceName": "agent-agent_012_04",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_012_04",
        "title": "@regression Regression protects downstream api contract behavior after record-jobs.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/scheduler/record-jobs.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/service/src/scheduler/record-jobs.ts.]",
        "displayTitle": "Regression protects downstream api contract behavior after record-jobs.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 15
      },
      {
        "id": "AGENT_008_05",
        "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/admin/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (api_impact, file_neighbors) provides downstream relationship context.]",
        "displayTitle": "Regression protects downstream api contract behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 12
      },
      {
        "id": "AGENT_009_05",
        "title": "@regression Regression protects downstream api contract behavior after routes.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/apps/routes.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/service/src/apps/routes.ts.]",
        "displayTitle": "Regression protects downstream api contract behavior after routes.ts",
        "surface": "API",
        "feature": "API contract",
        "score": 12
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_012_04 covers this Regression scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression protects downstream api contract behavior after record-jobs.ts [surface: API] [feature: API contract] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream API workflow connected to apps/service/src/scheduler/record-jobs.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/service/src/scheduler/record-jobs.ts.]"
  },
  {
    "id": "AGENT_013_01",
    "suite": "keystone-list-view",
    "surface": "keystone",
    "scenario": "Keystone / Shockwave regression for Keystone / Shockwave",
    "testCase": "Sanity verifies keystone / shockwave happy path after App.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted Keystone feature. | Exercise the primary user or API path related to apps/shockwave/src/App.tsx. | Capture evidence after the happy path completes.",
    "expected": "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    "risk": "Low",
    "sourcePath": "apps/shockwave/src/App.tsx",
    "surfaceLabel": "Keystone",
    "feature": "Keystone / Shockwave",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Sanity",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Focused sanity coverage for apps/shockwave/src/App.tsx.",
    "evidenceName": "agent-agent_013_01",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_013_01",
        "title": "@sanity Sanity verifies keystone / shockwave happy path after App.tsx [surface: Keystone] [feature: Keystone / Shockwave] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Keystone feature. | Exercise the primary user or API path related to apps/shockwave/src/App.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/shockwave/src/App.tsx.]",
        "displayTitle": "Sanity verifies keystone / shockwave happy path after App.tsx",
        "surface": "Keystone",
        "feature": "Keystone / Shockwave",
        "score": 13
      },
      {
        "id": "AGENT_014_01",
        "title": "@sanity Sanity verifies validation happy path after LookupListModal.tsx [surface: Keystone] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Keystone feature. | Exercise the primary user or API path related to apps/shockwave/src/components/LookupListModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/shockwave/src/components/LookupListModal.tsx.]",
        "displayTitle": "Sanity verifies validation happy path after LookupListModal.tsx",
        "surface": "Keystone",
        "feature": "Validation",
        "score": 12
      },
      {
        "id": "AGENT_015_01",
        "title": "@sanity Sanity verifies metadata and records happy path after recordCreationLayout.ts [surface: Keystone] [feature: Metadata and records] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Keystone feature. | Exercise the primary user or API path related to apps/shockwave/src/utils/recordCreationLayout.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/shockwave/src/utils/recordCreationLayout.ts.]",
        "displayTitle": "Sanity verifies metadata and records happy path after recordCreationLayout.ts",
        "surface": "Keystone",
        "feature": "Metadata and records",
        "score": 11
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_013_01 covers this Sanity scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Sanity verifies keystone / shockwave happy path after App.tsx [surface: Keystone] [feature: Keystone / Shockwave] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Keystone feature. | Exercise the primary user or API path related to apps/shockwave/src/App.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/shockwave/src/App.tsx.]"
  },
  {
    "id": "AGENT_013_02",
    "suite": "keystone-list-view",
    "surface": "keystone",
    "scenario": "Keystone / Shockwave regression for Keystone / Shockwave",
    "testCase": "Regression protects downstream keystone / shockwave behavior after App.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open a downstream Keystone workflow connected to apps/shockwave/src/App.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.",
    "expected": "Connected downstream behavior remains stable after the code change.",
    "risk": "Low",
    "sourcePath": "apps/shockwave/src/App.tsx",
    "surfaceLabel": "Keystone",
    "feature": "Keystone / Shockwave",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Regression",
    "level": "Regression",
    "tag": "@regression",
    "proof": "Downstream regression coverage for apps/shockwave/src/App.tsx.",
    "evidenceName": "agent-agent_013_02",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_013_02",
        "title": "@regression Regression protects downstream keystone / shockwave behavior after App.tsx [surface: Keystone] [feature: Keystone / Shockwave] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Keystone workflow connected to apps/shockwave/src/App.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/shockwave/src/App.tsx.]",
        "displayTitle": "Regression protects downstream keystone / shockwave behavior after App.tsx",
        "surface": "Keystone",
        "feature": "Keystone / Shockwave",
        "score": 13
      },
      {
        "id": "AGENT_014_03",
        "title": "@regression Regression protects downstream validation behavior after LookupListModal.tsx [surface: Keystone] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Keystone workflow connected to apps/shockwave/src/components/LookupListModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/shockwave/src/components/LookupListModal.tsx.]",
        "displayTitle": "Regression protects downstream validation behavior after LookupListModal.tsx",
        "surface": "Keystone",
        "feature": "Validation",
        "score": 12
      },
      {
        "id": "AGENT_015_02",
        "title": "@regression Regression protects downstream metadata and records behavior after recordCreationLayout.ts [surface: Keystone] [feature: Metadata and records] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Keystone workflow connected to apps/shockwave/src/utils/recordCreationLayout.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/shockwave/src/utils/recordCreationLayout.ts.]",
        "displayTitle": "Regression protects downstream metadata and records behavior after recordCreationLayout.ts",
        "surface": "Keystone",
        "feature": "Metadata and records",
        "score": 11
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_013_02 covers this Regression scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression protects downstream keystone / shockwave behavior after App.tsx [surface: Keystone] [feature: Keystone / Shockwave] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Keystone workflow connected to apps/shockwave/src/App.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/shockwave/src/App.tsx.]"
  },
  {
    "id": "AGENT_014_01",
    "suite": "keystone-list-view",
    "surface": "keystone",
    "scenario": "Keystone / Shockwave regression for Keystone / Shockwave",
    "testCase": "Sanity verifies validation happy path after LookupListModal.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted Keystone feature. | Exercise the primary user or API path related to apps/shockwave/src/components/LookupListModal.tsx. | Capture evidence after the happy path completes.",
    "expected": "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    "risk": "Low",
    "sourcePath": "apps/shockwave/src/components/LookupListModal.tsx",
    "surfaceLabel": "Keystone",
    "feature": "Validation",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Sanity",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Focused sanity coverage for apps/shockwave/src/components/LookupListModal.tsx.",
    "evidenceName": "agent-agent_014_01",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_014_01",
        "title": "@sanity Sanity verifies validation happy path after LookupListModal.tsx [surface: Keystone] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Keystone feature. | Exercise the primary user or API path related to apps/shockwave/src/components/LookupListModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/shockwave/src/components/LookupListModal.tsx.]",
        "displayTitle": "Sanity verifies validation happy path after LookupListModal.tsx",
        "surface": "Keystone",
        "feature": "Validation",
        "score": 14
      },
      {
        "id": "AGENT_013_01",
        "title": "@sanity Sanity verifies keystone / shockwave happy path after App.tsx [surface: Keystone] [feature: Keystone / Shockwave] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Keystone feature. | Exercise the primary user or API path related to apps/shockwave/src/App.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/shockwave/src/App.tsx.]",
        "displayTitle": "Sanity verifies keystone / shockwave happy path after App.tsx",
        "surface": "Keystone",
        "feature": "Keystone / Shockwave",
        "score": 11
      },
      {
        "id": "AGENT_014_02",
        "title": "@sanity Validation checks guarded behavior after LookupListModal.tsx [surface: Keystone] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Keystone feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/shockwave/src/components/LookupListModal.tsx.]",
        "displayTitle": "Validation checks guarded behavior after LookupListModal.tsx",
        "surface": "Keystone",
        "feature": "Validation",
        "score": 11
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_014_01 covers this Sanity scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Sanity verifies validation happy path after LookupListModal.tsx [surface: Keystone] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Keystone feature. | Exercise the primary user or API path related to apps/shockwave/src/components/LookupListModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/shockwave/src/components/LookupListModal.tsx.]"
  },
  {
    "id": "AGENT_014_02",
    "suite": "keystone-list-view",
    "surface": "keystone",
    "scenario": "Keystone / Shockwave regression for Keystone / Shockwave",
    "testCase": "Validation checks guarded behavior after LookupListModal.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted Keystone feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.",
    "expected": "Invalid or unauthorized input is rejected with a safe error state and no crash.",
    "risk": "Low",
    "sourcePath": "apps/shockwave/src/components/LookupListModal.tsx",
    "surfaceLabel": "Keystone",
    "feature": "Validation",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Validation",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Guarded behavior coverage for apps/shockwave/src/components/LookupListModal.tsx.",
    "evidenceName": "agent-agent_014_02",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_014_02",
        "title": "@sanity Validation checks guarded behavior after LookupListModal.tsx [surface: Keystone] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Keystone feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/shockwave/src/components/LookupListModal.tsx.]",
        "displayTitle": "Validation checks guarded behavior after LookupListModal.tsx",
        "surface": "Keystone",
        "feature": "Validation",
        "score": 13
      },
      {
        "id": "AGENT_014_03",
        "title": "@regression Regression protects downstream validation behavior after LookupListModal.tsx [surface: Keystone] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Keystone workflow connected to apps/shockwave/src/components/LookupListModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/shockwave/src/components/LookupListModal.tsx.]",
        "displayTitle": "Regression protects downstream validation behavior after LookupListModal.tsx",
        "surface": "Keystone",
        "feature": "Validation",
        "score": 11
      },
      {
        "id": "AGENT_014_01",
        "title": "@sanity Sanity verifies validation happy path after LookupListModal.tsx [surface: Keystone] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Keystone feature. | Exercise the primary user or API path related to apps/shockwave/src/components/LookupListModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/shockwave/src/components/LookupListModal.tsx.]",
        "displayTitle": "Sanity verifies validation happy path after LookupListModal.tsx",
        "surface": "Keystone",
        "feature": "Validation",
        "score": 10
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_014_02 covers this Validation scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Validation checks guarded behavior after LookupListModal.tsx [surface: Keystone] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Keystone feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/shockwave/src/components/LookupListModal.tsx.]"
  },
  {
    "id": "AGENT_014_03",
    "suite": "keystone-list-view",
    "surface": "keystone",
    "scenario": "Keystone / Shockwave regression for Keystone / Shockwave",
    "testCase": "Regression protects downstream validation behavior after LookupListModal.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open a downstream Keystone workflow connected to apps/shockwave/src/components/LookupListModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.",
    "expected": "Connected downstream behavior remains stable after the code change.",
    "risk": "Low",
    "sourcePath": "apps/shockwave/src/components/LookupListModal.tsx",
    "surfaceLabel": "Keystone",
    "feature": "Validation",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Regression",
    "level": "Regression",
    "tag": "@regression",
    "proof": "Downstream regression coverage for apps/shockwave/src/components/LookupListModal.tsx.",
    "evidenceName": "agent-agent_014_03",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_014_03",
        "title": "@regression Regression protects downstream validation behavior after LookupListModal.tsx [surface: Keystone] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Keystone workflow connected to apps/shockwave/src/components/LookupListModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/shockwave/src/components/LookupListModal.tsx.]",
        "displayTitle": "Regression protects downstream validation behavior after LookupListModal.tsx",
        "surface": "Keystone",
        "feature": "Validation",
        "score": 14
      },
      {
        "id": "AGENT_013_02",
        "title": "@regression Regression protects downstream keystone / shockwave behavior after App.tsx [surface: Keystone] [feature: Keystone / Shockwave] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Keystone workflow connected to apps/shockwave/src/App.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/shockwave/src/App.tsx.]",
        "displayTitle": "Regression protects downstream keystone / shockwave behavior after App.tsx",
        "surface": "Keystone",
        "feature": "Keystone / Shockwave",
        "score": 11
      },
      {
        "id": "AGENT_014_02",
        "title": "@sanity Validation checks guarded behavior after LookupListModal.tsx [surface: Keystone] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Keystone feature. | Submit one invalid or unauthorized edge-case input. | Verify the app/API rejects it visibly without leaking data.] [expected: Invalid or unauthorized input is rejected with a safe error state and no crash.] [proof: Guarded behavior coverage for apps/shockwave/src/components/LookupListModal.tsx.]",
        "displayTitle": "Validation checks guarded behavior after LookupListModal.tsx",
        "surface": "Keystone",
        "feature": "Validation",
        "score": 11
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_014_03 covers this Regression scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression protects downstream validation behavior after LookupListModal.tsx [surface: Keystone] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Keystone workflow connected to apps/shockwave/src/components/LookupListModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/shockwave/src/components/LookupListModal.tsx.]"
  },
  {
    "id": "AGENT_015_01",
    "suite": "keystone-list-view",
    "surface": "keystone",
    "scenario": "Keystone / Shockwave regression for Keystone / Shockwave",
    "testCase": "Sanity verifies metadata and records happy path after recordCreationLayout.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted Keystone feature. | Exercise the primary user or API path related to apps/shockwave/src/utils/recordCreationLayout.ts. | Capture evidence after the happy path completes.",
    "expected": "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    "risk": "Medium",
    "sourcePath": "apps/shockwave/src/utils/recordCreationLayout.ts",
    "surfaceLabel": "Keystone",
    "feature": "Metadata and records",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Sanity",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Focused sanity coverage for apps/shockwave/src/utils/recordCreationLayout.ts.",
    "evidenceName": "agent-agent_015_01",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_015_01",
        "title": "@sanity Sanity verifies metadata and records happy path after recordCreationLayout.ts [surface: Keystone] [feature: Metadata and records] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Keystone feature. | Exercise the primary user or API path related to apps/shockwave/src/utils/recordCreationLayout.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/shockwave/src/utils/recordCreationLayout.ts.]",
        "displayTitle": "Sanity verifies metadata and records happy path after recordCreationLayout.ts",
        "surface": "Keystone",
        "feature": "Metadata and records",
        "score": 15
      },
      {
        "id": "AGENT_013_01",
        "title": "@sanity Sanity verifies keystone / shockwave happy path after App.tsx [surface: Keystone] [feature: Keystone / Shockwave] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Keystone feature. | Exercise the primary user or API path related to apps/shockwave/src/App.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/shockwave/src/App.tsx.]",
        "displayTitle": "Sanity verifies keystone / shockwave happy path after App.tsx",
        "surface": "Keystone",
        "feature": "Keystone / Shockwave",
        "score": 11
      },
      {
        "id": "AGENT_014_01",
        "title": "@sanity Sanity verifies validation happy path after LookupListModal.tsx [surface: Keystone] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Keystone feature. | Exercise the primary user or API path related to apps/shockwave/src/components/LookupListModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/shockwave/src/components/LookupListModal.tsx.]",
        "displayTitle": "Sanity verifies validation happy path after LookupListModal.tsx",
        "surface": "Keystone",
        "feature": "Validation",
        "score": 11
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_015_01 covers this Sanity scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Sanity verifies metadata and records happy path after recordCreationLayout.ts [surface: Keystone] [feature: Metadata and records] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Keystone feature. | Exercise the primary user or API path related to apps/shockwave/src/utils/recordCreationLayout.ts. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/shockwave/src/utils/recordCreationLayout.ts.]"
  },
  {
    "id": "AGENT_015_02",
    "suite": "keystone-list-view",
    "surface": "keystone",
    "scenario": "Keystone / Shockwave regression for Keystone / Shockwave",
    "testCase": "Regression protects downstream metadata and records behavior after recordCreationLayout.ts",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open a downstream Keystone workflow connected to apps/shockwave/src/utils/recordCreationLayout.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.",
    "expected": "Connected downstream behavior remains stable after the code change.",
    "risk": "Medium",
    "sourcePath": "apps/shockwave/src/utils/recordCreationLayout.ts",
    "surfaceLabel": "Keystone",
    "feature": "Metadata and records",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Regression",
    "level": "Regression",
    "tag": "@regression",
    "proof": "Downstream regression coverage for apps/shockwave/src/utils/recordCreationLayout.ts.",
    "evidenceName": "agent-agent_015_02",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_015_02",
        "title": "@regression Regression protects downstream metadata and records behavior after recordCreationLayout.ts [surface: Keystone] [feature: Metadata and records] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Keystone workflow connected to apps/shockwave/src/utils/recordCreationLayout.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/shockwave/src/utils/recordCreationLayout.ts.]",
        "displayTitle": "Regression protects downstream metadata and records behavior after recordCreationLayout.ts",
        "surface": "Keystone",
        "feature": "Metadata and records",
        "score": 15
      },
      {
        "id": "AGENT_013_02",
        "title": "@regression Regression protects downstream keystone / shockwave behavior after App.tsx [surface: Keystone] [feature: Keystone / Shockwave] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Keystone workflow connected to apps/shockwave/src/App.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/shockwave/src/App.tsx.]",
        "displayTitle": "Regression protects downstream keystone / shockwave behavior after App.tsx",
        "surface": "Keystone",
        "feature": "Keystone / Shockwave",
        "score": 11
      },
      {
        "id": "AGENT_014_03",
        "title": "@regression Regression protects downstream validation behavior after LookupListModal.tsx [surface: Keystone] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Keystone workflow connected to apps/shockwave/src/components/LookupListModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/shockwave/src/components/LookupListModal.tsx.]",
        "displayTitle": "Regression protects downstream validation behavior after LookupListModal.tsx",
        "surface": "Keystone",
        "feature": "Validation",
        "score": 11
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_015_02 covers this Regression scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression protects downstream metadata and records behavior after recordCreationLayout.ts [surface: Keystone] [feature: Metadata and records] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Keystone workflow connected to apps/shockwave/src/utils/recordCreationLayout.ts. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/shockwave/src/utils/recordCreationLayout.ts.]"
  },
  {
    "id": "AGENT_016_01",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Application regression for Application",
    "testCase": "Sanity verifies application ui happy path after component-catalog.md",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted Admin feature. | Exercise the primary user or API path related to docs/ui/component-catalog.md. | Capture evidence after the happy path completes.",
    "expected": "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    "risk": "Low",
    "sourcePath": "docs/ui/component-catalog.md",
    "surfaceLabel": "Admin",
    "feature": "Application UI",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Sanity",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Focused sanity coverage for docs/ui/component-catalog.md.",
    "evidenceName": "agent-agent_016_01",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_016_01",
        "title": "@sanity Sanity verifies application ui happy path after component-catalog.md [surface: Admin] [feature: Application UI] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to docs/ui/component-catalog.md. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for docs/ui/component-catalog.md.]",
        "displayTitle": "Sanity verifies application ui happy path after component-catalog.md",
        "surface": "Admin",
        "feature": "Application UI",
        "score": 11
      },
      {
        "id": "AGENT_007_01",
        "title": "@sanity Sanity verifies application ui happy path after style.css [surface: Admin] [feature: Application UI] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/style.css. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/style.css.]",
        "displayTitle": "Sanity verifies application ui happy path after style.css",
        "surface": "Admin",
        "feature": "Application UI",
        "score": 8
      },
      {
        "id": "AGENT_001_01",
        "title": "@sanity Sanity verifies validation happy path after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminConfirmModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Sanity verifies validation happy path after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 7
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_016_01 covers this Sanity scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Sanity verifies application ui happy path after component-catalog.md [surface: Admin] [feature: Application UI] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to docs/ui/component-catalog.md. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for docs/ui/component-catalog.md.]"
  },
  {
    "id": "AGENT_016_02",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Application regression for Application",
    "testCase": "Regression protects downstream application ui behavior after component-catalog.md",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open a downstream Admin workflow connected to docs/ui/component-catalog.md. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.",
    "expected": "Connected downstream behavior remains stable after the code change.",
    "risk": "Low",
    "sourcePath": "docs/ui/component-catalog.md",
    "surfaceLabel": "Admin",
    "feature": "Application UI",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Regression",
    "level": "Regression",
    "tag": "@regression",
    "proof": "Downstream regression coverage for docs/ui/component-catalog.md.",
    "evidenceName": "agent-agent_016_02",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_016_02",
        "title": "@regression Regression protects downstream application ui behavior after component-catalog.md [surface: Admin] [feature: Application UI] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to docs/ui/component-catalog.md. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for docs/ui/component-catalog.md.]",
        "displayTitle": "Regression protects downstream application ui behavior after component-catalog.md",
        "surface": "Admin",
        "feature": "Application UI",
        "score": 11
      },
      {
        "id": "AGENT_007_02",
        "title": "@regression Regression protects downstream application ui behavior after style.css [surface: Admin] [feature: Application UI] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/style.css. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/style.css.]",
        "displayTitle": "Regression protects downstream application ui behavior after style.css",
        "surface": "Admin",
        "feature": "Application UI",
        "score": 8
      },
      {
        "id": "AGENT_001_03",
        "title": "@regression Regression protects downstream validation behavior after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminConfirmModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Regression protects downstream validation behavior after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 7
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_016_02 covers this Regression scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression protects downstream application ui behavior after component-catalog.md [surface: Admin] [feature: Application UI] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to docs/ui/component-catalog.md. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for docs/ui/component-catalog.md.]"
  },
  {
    "id": "AGENT_017_01",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Shared UI regression for Shared UI",
    "testCase": "Sanity verifies shared ui happy path after index.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open the impacted Admin feature. | Exercise the primary user or API path related to packages/ui/src/index.tsx. | Capture evidence after the happy path completes.",
    "expected": "The changed feature completes its primary path and leaves the page/API response in a valid state.",
    "risk": "Low",
    "sourcePath": "packages/ui/src/index.tsx",
    "surfaceLabel": "Admin",
    "feature": "Shared UI",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Sanity",
    "level": "Sanity",
    "tag": "@sanity",
    "proof": "Focused sanity coverage for packages/ui/src/index.tsx.",
    "evidenceName": "agent-agent_017_01",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_017_01",
        "title": "@sanity Sanity verifies shared ui happy path after index.tsx [surface: Admin] [feature: Shared UI] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to packages/ui/src/index.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for packages/ui/src/index.tsx.]",
        "displayTitle": "Sanity verifies shared ui happy path after index.tsx",
        "surface": "Admin",
        "feature": "Shared UI",
        "score": 12
      },
      {
        "id": "AGENT_001_01",
        "title": "@sanity Sanity verifies validation happy path after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminConfirmModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Sanity verifies validation happy path after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 9
      },
      {
        "id": "AGENT_002_02",
        "title": "@sanity Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: GitNexus MCP evidence (file_neighbors) links the change to this feature path.]",
        "displayTitle": "Sanity verifies security happy path after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 9
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_017_01 covers this Sanity scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@sanity Sanity verifies shared ui happy path after index.tsx [surface: Admin] [feature: Shared UI] [level: Sanity] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open the impacted Admin feature. | Exercise the primary user or API path related to packages/ui/src/index.tsx. | Capture evidence after the happy path completes.] [expected: The changed feature completes its primary path and leaves the page/API response in a valid state.] [proof: Focused sanity coverage for packages/ui/src/index.tsx.]"
  },
  {
    "id": "AGENT_017_02",
    "suite": "admin-list-view",
    "surface": "admin",
    "scenario": "Shared UI regression for Shared UI",
    "testCase": "Regression protects downstream shared ui behavior after index.tsx",
    "precondition": "Core Platform local stack is available and seeded test credentials can sign in.",
    "steps": "Open a downstream Admin workflow connected to packages/ui/src/index.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.",
    "expected": "Connected downstream behavior remains stable after the code change.",
    "risk": "Low",
    "sourcePath": "packages/ui/src/index.tsx",
    "surfaceLabel": "Admin",
    "feature": "Shared UI",
    "adminScreen": "Apps",
    "graphSource": "gitnexus-mcp-busy",
    "graphEvidence": "",
    "gitNexus": null,
    "safeDataPolicy": "seeded-or-disposable-data",
    "resetRequired": false,
    "scenarioFamily": "Regression",
    "level": "Regression",
    "tag": "@regression",
    "proof": "Downstream regression coverage for packages/ui/src/index.tsx.",
    "evidenceName": "agent-agent_017_02",
    "action": "reuse",
    "existingTests": [
      {
        "id": "AGENT_017_02",
        "title": "@regression Regression protects downstream shared ui behavior after index.tsx [surface: Admin] [feature: Shared UI] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to packages/ui/src/index.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for packages/ui/src/index.tsx.]",
        "displayTitle": "Regression protects downstream shared ui behavior after index.tsx",
        "surface": "Admin",
        "feature": "Shared UI",
        "score": 12
      },
      {
        "id": "AGENT_001_03",
        "title": "@regression Regression protects downstream validation behavior after AdminConfirmModal.tsx [surface: Admin] [feature: Validation] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminConfirmModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for apps/admin/src/components/AdminConfirmModal.tsx.]",
        "displayTitle": "Regression protects downstream validation behavior after AdminConfirmModal.tsx",
        "surface": "Admin",
        "feature": "Validation",
        "score": 9
      },
      {
        "id": "AGENT_002_05",
        "title": "@regression Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx [surface: Admin] [feature: Security] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to apps/admin/src/components/AdminCreateAccessRecordModal.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: GitNexus MCP evidence (file_neighbors) provides downstream relationship context.]",
        "displayTitle": "Regression protects downstream security behavior after AdminCreateAccessRecordModal.tsx",
        "surface": "Admin",
        "feature": "Security",
        "score": 9
      }
    ],
    "coverageDecision": "reuse-existing",
    "decision": "Existing AGENT_017_02 covers this Regression scenario; reuse it instead of duplicating.",
    "planner": "rules",
    "title": "@regression Regression protects downstream shared ui behavior after index.tsx [surface: Admin] [feature: Shared UI] [level: Regression] [precondition: Core Platform local stack is available and seeded test credentials can sign in.] [input: Open a downstream Admin workflow connected to packages/ui/src/index.tsx. | Run search, navigation, refresh, settings, or API readback behavior. | Verify the workflow remains stable.] [expected: Connected downstream behavior remains stable after the code change.] [proof: Downstream regression coverage for packages/ui/src/index.tsx.]"
  }
];

test.describe("AI generated change-impact smoke tests", () => {
  for (const generatedCase of generatedCases) {
    test(generatedCase.title, async ({ page, request }, testInfo) => {
      test.skip(!hasCredentials(), "Seeded test credentials are not configured.");
      test.skip(Boolean(generatedCase.resetRequired) && process.env.ALLOW_DATA_WRITE !== "true", "Guarded write scenarios require ALLOW_DATA_WRITE=true and reset-enabled runs.");

      if (generatedCase.action === "reuse") {
        testInfo.annotations.push({
          type: "agent-reuse",
          description: (generatedCase.existingTests || []).map((item) => item.id || item.title).join(", ")
        });
      }
      const evidencePayload = {
        id: generatedCase.id,
        family: generatedCase.scenarioFamily,
        action: generatedCase.action,
        reused: (generatedCase.existingTests || []).map((item) => item.id),
        graph: generatedCase.graphSource,
        evidence: generatedCase.graphEvidence
      };

      if (generatedCase.surface === "api") {
        const token = await apiLogin(request);
        const response = await request.get("/api/apps", {
          headers: { Authorization: `Bearer ${token}` }
        });
        expect(response.ok(), await response.text()).toBeTruthy();
        const screenshotPath = testInfo.outputPath(`${generatedCase.evidenceName}-api-evidence.png`);
        await page.setContent(`<!doctype html><html><body style="font-family:Arial;padding:24px;background:#0f172a;color:#e5eefc"><h1>${generatedCase.testCase}</h1><pre>${JSON.stringify(evidencePayload, null, 2).replace(/[<>&]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[char] || char))}</pre></body></html>`);
        await page.screenshot({ fullPage: true, path: screenshotPath });
        await testInfo.attach(`screenshot-${generatedCase.evidenceName}`, {
          path: screenshotPath,
          contentType: "image/png"
        });
        return;
      }

      if (generatedCase.surface === "keystone") {
        await loginToKeystone(page);
        await selectKeystoneAppAndTab(page);
        await expect(page.locator(".object-home").first()).toBeVisible();
      } else {
        await loginToAdmin(page);
        const screen = generatedCase.adminScreen || "Apps";
        const main = await openAdminScreen(page, screen);
        await expect(main).toBeVisible();
      }

      await attachEvidence(page, testInfo, generatedCase.evidenceName).catch(() => null);
    });
  }
});
