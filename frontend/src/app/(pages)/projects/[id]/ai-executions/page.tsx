"use client";

import { use } from "react";
import { AiExecutionPanel } from "@/app/components/projects/AiExecutionPanel";

export default function AiExecutionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <AiExecutionPanel projectId={id} />;
}
