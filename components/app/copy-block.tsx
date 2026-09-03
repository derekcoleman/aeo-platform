"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CopyBlock({ text, label, filename }: { text: string; label?: string; filename?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border">
      <div className="bg-muted/50 flex items-center justify-between rounded-t-lg border-b px-3 py-1.5 text-xs">
        <span className="font-mono">{filename ?? label ?? ""}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="max-h-96 overflow-auto p-3 font-mono text-xs leading-relaxed">{text}</pre>
    </div>
  );
}
