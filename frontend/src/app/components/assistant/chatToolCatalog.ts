export type ChatToolCatalogItem = {
  name: string;
  label: string;
  description: string;
  projectOnly?: boolean;
};

export const CHAT_TOOL_CATALOG: ChatToolCatalogItem[] = [
  {
    name: "read_document",
    label: "Read documents",
    description: "Read the full text of an attached document.",
  },
  {
    name: "find_in_document",
    label: "Find in document",
    description: "Find exact text and nearby context.",
  },
  {
    name: "generate_docx",
    label: "Create Word document",
    description: "Generate a downloadable .docx file.",
  },
  {
    name: "edit_document",
    label: "Edit Word document",
    description: "Propose tracked edits to a .docx file.",
  },
  {
    name: "list_workflows",
    label: "List workflows",
    description: "Discover available assistant workflows.",
  },
  {
    name: "read_workflow",
    label: "Run workflow",
    description: "Load and apply a selected workflow.",
  },
  {
    name: "get_user_pdf_annotations",
    label: "Read my annotations",
    description: "Retrieve your PDF highlights, comments, and notes.",
    projectOnly: true,
  },
  {
    name: "list_documents",
    label: "List project documents",
    description: "Discover documents in this project.",
    projectOnly: true,
  },
  {
    name: "search_project_documents",
    label: "Search project",
    description: "Search across indexed project documents.",
    projectOnly: true,
  },
  {
    name: "read_index_chunk",
    label: "Read search context",
    description: "Read exact context around a search result.",
    projectOnly: true,
  },
  {
    name: "fetch_documents",
    label: "Read multiple documents",
    description: "Read a bounded set of selected documents.",
    projectOnly: true,
  },
  {
    name: "replicate_document",
    label: "Copy document",
    description: "Create an editable copy of a project document.",
    projectOnly: true,
  },
];

export function availableChatTools(projectMode: boolean) {
  return CHAT_TOOL_CATALOG.filter((tool) => projectMode || !tool.projectOnly);
}
