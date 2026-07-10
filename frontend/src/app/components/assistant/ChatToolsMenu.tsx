"use client";

import { Wrench } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { availableChatTools } from "./chatToolCatalog";

interface Props {
  disabledTools: Set<string>;
  onToggle: (toolName: string, enabled: boolean) => void;
  projectMode?: boolean;
}

export function ChatToolsMenu({
  disabledTools,
  onToggle,
  projectMode = false,
}: Props) {
  const tools = availableChatTools(projectMode);
  const disabledCount = tools.filter((tool) => disabledTools.has(tool.name)).length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-session-check="chat-tools-trigger"
          aria-label="Configure chat tools"
          className={`flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm transition-colors ${
            disabledCount > 0
              ? "bg-amber-50 text-amber-700 hover:bg-amber-100"
              : "text-gray-500 hover:bg-gray-100 hover:text-gray-800"
          }`}
        >
          <Wrench className="h-3.5 w-3.5" />
          <span>Tools</span>
          {disabledCount > 0 && (
            <span className="rounded-full bg-amber-200 px-1.5 text-[10px] font-medium leading-4">
              {disabledCount} off
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-session-check="chat-tools-menu"
        align="start"
        side="bottom"
        className="w-[340px] overflow-y-auto p-1.5"
      >
        <DropdownMenuLabel className="px-2 pb-1 pt-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
          Tools
        </DropdownMenuLabel>
        {tools.map((tool) => {
          const enabled = !disabledTools.has(tool.name);
          return (
            <DropdownMenuCheckboxItem
              key={tool.name}
              checked={enabled}
              onCheckedChange={(checked) => onToggle(tool.name, checked === true)}
              onSelect={(event) => event.preventDefault()}
              data-tool-name={tool.name}
              className="items-center px-2 py-2.5 pl-2 [&>span:first-child]:hidden"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-800">
                  {tool.label}
                </span>
                <span className="mt-0.5 block text-xs leading-4 text-gray-400">
                  {tool.description}
                </span>
              </span>
              <span
                aria-hidden="true"
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                  enabled ? "bg-black" : "bg-gray-200"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                    enabled ? "translate-x-[18px]" : "translate-x-0.5"
                  }`}
                />
              </span>
            </DropdownMenuCheckboxItem>
          );
        })}

        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuLabel className="px-2 pb-1 pt-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
          MCP
        </DropdownMenuLabel>
        <div className="px-2 pb-2 text-xs leading-5 text-gray-400">
          No MCP servers connected.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
