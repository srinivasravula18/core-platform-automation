import type { ObjectDescriptor } from "@atp/shared";

/** Real leave_request metadata (verified live via the core_platform_db MCP). */
export const leaveRequest: ObjectDescriptor = {
  object: { id: "obj0000011", api_name: "leave_request", label: "Leave Request", id_prefix: "lve", app: "hr" },
  fields: [
    { id: "1", api_name: "id", label: "ID", type: "text", required: true, searchable: false },
    { id: "2", api_name: "start_date", label: "Start Date", type: "date", required: true, searchable: false },
    { id: "3", api_name: "end_date", label: "End Date", type: "date", required: true, searchable: false },
    { id: "4", api_name: "leave_type", label: "Leave Type", type: "picklist", required: false, searchable: false },
    { id: "5", api_name: "status", label: "Status", type: "picklist", required: false, searchable: false },
    { id: "6", api_name: "employee_id", label: "Employee", type: "reference", required: false, searchable: false, reference_object: "employee" },
    { id: "7", api_name: "name", label: "Name", type: "text", required: false, searchable: true },
    { id: "8", api_name: "notes", label: "Notes", type: "textarea", required: false, searchable: false },
    { id: "9", api_name: "approved", label: "Approved", type: "boolean", required: false, searchable: false },
  ],
  picklists: {
    leave_type: [
      { value: "annual", label: "Annual", active: true },
      { value: "sick", label: "Sick", active: true },
      { value: "unpaid", label: "Unpaid", active: true },
    ],
    status: [
      { value: "pending", label: "Pending", active: true },
      { value: "approved", label: "Approved", active: true },
      { value: "rejected", label: "Rejected", active: true },
    ],
  },
  layouts: [],
  validationRules: [{ object: "leave_request", name: "end_after_start", expr: "end_date >= start_date", message: "End Date must be on or after Start Date" }],
  permissions: [{ object: "leave_request", role: "viewer", can_create: false, can_read: true, can_edit: false, can_delete: false }],
};
