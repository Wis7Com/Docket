"use client";

import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from "react";
import {
  ArrowRight,
  File,
  FileText,
  Library,
  Square,
  X,
} from "lucide-react";
import { AddDocButton } from "./AddDocButton";
import { AddDocumentsModal } from "../shared/AddDocumentsModal";
import { ApiKeyMissingModal } from "../shared/ApiKeyMissingModal";
import { ChatToolsMenu } from "./ChatToolsMenu";
import { ModelToggle } from "./ModelToggle";
import { BUILT_IN_WORKFLOWS } from "../workflows/builtinWorkflows";
import {
  persistSelectedModelForChat,
  useSelectedModel,
} from "@/app/hooks/useSelectedModel";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { listWorkflows } from "@/app/lib/docketApi";
import {
  getModelProvider,
  isModelAvailable,
  type ModelProvider,
} from "@/app/lib/modelAvailability";
import type {
  DocketDocument,
  DocketMessage,
  DocketWorkflow,
} from "../shared/types";
import {
  findWorkflowMention,
  removeWorkflowMention,
  type WorkflowMention,
} from "./workflowMentions";

export interface ChatInputHandle {
  addDoc: (doc: DocketDocument) => void;
}

interface Props {
  onSubmit: (message: DocketMessage) => void;
  onQueueMessage?: (message: DocketMessage) => void;
  onCancel: () => void;
  isLoading: boolean;
  hasQueuedMessage?: boolean;
  restoreDraft?: string | null;
  onDraftRestored?: () => void;
  hideAddDocButton?: boolean;
  hideWorkflowButton?: boolean;
  onProjectsClick?: () => void;
  projectMode?: boolean;
  chatId?: string;
  projectId?: string;
  /**
   * True when the project has documents but the user has unchecked every
   * one as a chat source. Submission is blocked unless the message carries
   * its own attachment (which becomes the source scope).
   */
  noSourcesSelected?: boolean;
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
  {
    onSubmit,
    onQueueMessage,
    onCancel,
    isLoading,
    hasQueuedMessage = false,
    restoreDraft,
    onDraftRestored,
    hideAddDocButton,
    hideWorkflowButton,
    onProjectsClick,
    projectMode = false,
    chatId,
    projectId,
    noSourcesSelected = false,
  }: Props,
  ref,
) {
  const [value, setValue] = useState("");
  const [attachedDocs, setAttachedDocs] = useState<DocketDocument[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [workflows, setWorkflows] = useState<DocketWorkflow[]>(() =>
    BUILT_IN_WORKFLOWS.filter((workflow) => workflow.type === "assistant"),
  );
  const [workflowMention, setWorkflowMention] =
    useState<WorkflowMention | null>(null);
  const [activeWorkflowIndex, setActiveWorkflowIndex] = useState(0);
  const [disabledTools, setDisabledTools] = useState<Set<string>>(
    () => new Set(),
  );
  const [model, setModel] = useSelectedModel(chatId, projectId);
  const { profile } = useUserProfile();
  const apiKeys = {
    claudeApiKey: profile?.claudeApiKey ?? null,
    geminiApiKey: profile?.geminiApiKey ?? null,
    openaiApiKey: profile?.openaiApiKey ?? null,
    openrouterApiKey: profile?.openrouterApiKey ?? null,
    nvidiaApiKey: profile?.nvidiaApiKey ?? null,
    openaiCompatibleApiKey: profile?.openaiCompatibleApiKey ?? null,
    openaiCompatibleBaseUrl: profile?.openaiCompatibleBaseUrl ?? null,
  };
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [docSelectorOpen, setDocSelectorOpen] = useState(false);
  const [apiKeyModalProvider, setApiKeyModalProvider] =
    useState<ModelProvider | null>(null);

  useEffect(() => {
    if (!restoreDraft || value.trim()) return;
    setValue(restoreDraft);
    onDraftRestored?.();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [onDraftRestored, restoreDraft, value]);

  useEffect(() => {
    let cancelled = false;
    listWorkflows("assistant")
      .then((custom) => {
        if (cancelled) return;
        const merged = new Map<string, DocketWorkflow>();
        for (const workflow of [
          ...BUILT_IN_WORKFLOWS.filter((item) => item.type === "assistant"),
          ...custom,
        ]) {
          merged.set(workflow.id, workflow);
        }
        setWorkflows([...merged.values()]);
      })
      .catch(() => {
        // Built-ins are already available; remote workflows are additive.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredWorkflows = useMemo(() => {
    if (!workflowMention) return [];
    const query = workflowMention.query.toLowerCase();
    return workflows.filter((workflow) =>
      workflow.title.toLowerCase().includes(query),
    );
  }, [workflowMention, workflows]);

  useImperativeHandle(ref, () => ({
    addDoc: (doc: DocketDocument) => {
      setAttachedDocs((prev) => {
        if (prev.some((d) => d.id === doc.id)) return prev;
        return [...prev, doc];
      });
    },
  }));

  const handleAddDocFromProject = useCallback((doc: DocketDocument) => {
    setAttachedDocs((prev) => {
      if (prev.some((d) => d.id === doc.id)) return prev;
      return [...prev, doc];
    });
  }, []);

  const handleAddDocsFromSelector = useCallback(
    (selectedDocs: DocketDocument[]) => {
      setAttachedDocs((prev) => {
        const existing = new Set(prev.map((d) => d.id));
        return [...prev, ...selectedDocs.filter((d) => !existing.has(d.id))];
      });
    },
    [],
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = e.target.value;
    setValue(nextValue);
    const nextMention = hideWorkflowButton
      ? null
      : findWorkflowMention(nextValue, e.target.selectionStart);
    setWorkflowMention(nextMention);
    if (nextMention?.query !== workflowMention?.query) {
      setActiveWorkflowIndex(0);
    }
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  // Blocked only when every project document is deselected AND the message
  // carries no direct attachment. An attachment re-enters the source scope,
  // so it stays allowed.
  const blockedForNoSources = noSourcesSelected && attachedDocs.length === 0;

  const handleSubmit = () => {
    const query = value.trim();
    if (!query || (isLoading && hasQueuedMessage)) return;
    if (blockedForNoSources) return;
    if (!isModelAvailable(model, apiKeys)) {
      setApiKeyModalProvider(getModelProvider(model));
      return;
    }
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    const files = attachedDocs.map((d) => ({
      filename: d.filename,
      document_id: d.id,
    }));
    setAttachedDocs([]);
    setWorkflowMention(null);
    const wf = selectedWorkflow;
    setSelectedWorkflow(null);

    // A submit also establishes the chat's model preference when the selector
    // has not been changed explicitly in this mount.
    if (chatId) persistSelectedModelForChat(chatId, projectId, model);

    const nextMessage = {
      role: "user",
      content: query,
      files: files.length > 0 ? files : undefined,
      workflow: wf ?? undefined,
      disabled_tools: [...disabledTools],
      model,
    } satisfies DocketMessage;
    if (isLoading) onQueueMessage?.(nextMessage);
    else onSubmit?.(nextMessage);
  };

  const selectWorkflow = (workflow: DocketWorkflow) => {
    if (!workflowMention) return;
    const next = removeWorkflowMention(value, workflowMention);
    setValue(next.value);
    setSelectedWorkflow({ id: workflow.id, title: workflow.title });
    setWorkflowMention(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const toggleTool = (toolName: string, enabled: boolean) => {
    setDisabledTools((current) => {
      const next = new Set(current);
      if (enabled) next.delete(toolName);
      else next.add(toolName);
      return next;
    });
  };

  const handleActionClick = () => {
    if (isLoading && !value.trim()) {
      onCancel();
    } else {
      handleSubmit();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (workflowMention && filteredWorkflows.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveWorkflowIndex((index) =>
          index + 1 >= filteredWorkflows.length ? 0 : index + 1,
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveWorkflowIndex((index) =>
          index - 1 < 0 ? filteredWorkflows.length - 1 : index - 1,
        );
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selectWorkflow(filteredWorkflows[activeWorkflowIndex]);
        return;
      }
    }
    if (workflowMention && e.key === "Escape") {
      e.preventDefault();
      setWorkflowMention(null);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <>
      <div className="w-full">
        <div className="border border-gray-300 rounded-[16px] md:rounded-[20px] bg-white">
          {/* Attached chips */}
          {(selectedWorkflow || attachedDocs.length > 0) && (
            <div className="flex flex-wrap gap-1.5 px-2 pt-2">
              {selectedWorkflow && (
                <div className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full text-xs bg-blue-600 text-white border border-white/20 shadow backdrop-blur-sm">
                  <Library className="h-2.5 w-2.5 shrink-0" />
                  <span className="max-w-[140px] truncate">
                    {selectedWorkflow.title}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedWorkflow(null)}
                    className="rounded-full p-0.5 ml-0.5 text-white/60 hover:text-white hover:bg-white/20 transition-colors"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              )}
              {attachedDocs.map((doc) => {
                const ft = doc.file_type?.toLowerCase();
                const isPdf = ft === "pdf";
                return (
                  <div
                    key={doc.id}
                    className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs text-white shadow border border-white/20 bg-black backdrop-blur-sm"
                  >
                    {isPdf ? (
                      <FileText className="h-2.5 w-2.5 shrink-0 text-red-400" />
                    ) : (
                      <File className="h-2.5 w-2.5 shrink-0 text-blue-400" />
                    )}
                    <span className="max-w-[140px] truncate">
                      {doc.filename}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setAttachedDocs((prev) =>
                          prev.filter((d) => d.id !== doc.id),
                        )
                      }
                      className="rounded-full p-0.5 ml-0.5 text-white/60 hover:text-white hover:bg-white/20 transition-colors"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* No-source notice */}
          {blockedForNoSources && (
            <div
              data-session-check="chat-no-sources-notice"
              className="px-4 pt-3 text-xs text-amber-600"
            >
              No source documents selected. Check at least one document in the
              panel, or attach one to your message.
            </div>
          )}

          {/* Input */}
          <div className="relative px-4 pt-4">
            {workflowMention && (
              <div
                data-session-check="workflow-mention-menu"
                role="listbox"
                aria-label="Workflows"
                className="absolute bottom-[calc(100%+8px)] left-2 z-50 max-h-72 w-[min(420px,calc(100vw-40px))] overflow-y-auto rounded-xl border border-gray-200 bg-white p-1.5 shadow-xl"
              >
                <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  Workflows
                </div>
                {filteredWorkflows.length > 0 ? (
                  filteredWorkflows.map((workflow, index) => (
                    <button
                      key={workflow.id}
                      type="button"
                      role="option"
                      aria-selected={index === activeWorkflowIndex}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectWorkflow(workflow)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                        index === activeWorkflowIndex
                          ? "bg-gray-100 text-gray-950"
                          : "text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      <Library className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                      <span className="truncate">{workflow.title}</span>
                    </button>
                  ))
                ) : (
                  <div className="px-2.5 py-3 text-sm text-gray-400">
                    No matching workflows
                  </div>
                )}
              </div>
            )}
            <textarea
              ref={textareaRef}
              data-session-check="chat-input-textarea"
              rows={1}
              placeholder="Ask a question about your documents..."
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              className="w-full resize-none text-sm overflow-hidden border-0 text-base p-0 bg-transparent outline-none placeholder:text-gray-400 leading-6 max-h-48"
            />
          </div>

          {/* Controls */}
          <div className="flex items-center justify-between md:p-2.5 p-2">
            <div className="flex items-center gap-1">
              {!hideAddDocButton && (
                <AddDocButton
                  onSelectDoc={handleAddDocFromProject}
                  onBrowseAll={() => setDocSelectorOpen(true)}
                  selectedDocIds={attachedDocs.map((d) => d.id)}
                  onProjectsClick={onProjectsClick}
                  projectId={projectId}
                />
              )}
              <ChatToolsMenu
                disabledTools={disabledTools}
                onToggle={toggleTool}
                projectMode={projectMode}
              />
            </div>

            <div className="flex items-center gap-1">
              <ModelToggle
                value={model}
                onChange={setModel}
                apiKeys={apiKeys}
              />
              <button
                type="button"
                data-session-check="chat-submit"
                className="relative bg-gradient-to-b from-neutral-700 to-black text-white rounded-[10px] h-8 w-8 flex items-center justify-center cursor-pointer disabled:cursor-default disabled:from-neutral-600 disabled:to-black backdrop-blur-xl border border-white/30 active:enabled:scale-95 transition-all duration-150"
                onClick={handleActionClick}
                disabled={
                  (!isLoading && (!value.trim() || blockedForNoSources)) ||
                  (isLoading && !!value.trim() && (hasQueuedMessage || blockedForNoSources))
                }
              >
                {isLoading && !value.trim() ? (
                  <Square
                    className="h-4 w-4"
                    fill="currentColor"
                    strokeWidth={0}
                  />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      <AddDocumentsModal
        open={docSelectorOpen}
        onClose={() => setDocSelectorOpen(false)}
        onSelect={handleAddDocsFromSelector}
        breadcrumb={["Assistant", "Add Documents"]}
        projectId={projectId}
      />
      <ApiKeyMissingModal
        open={apiKeyModalProvider !== null}
        provider={apiKeyModalProvider}
        onClose={() => setApiKeyModalProvider(null)}
      />
    </>
  );
});
