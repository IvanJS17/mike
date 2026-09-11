"use client";

import { use } from "react";
import { ApprovedDrivePublication } from "@/app/components/recovery/drive/ApprovedDrivePublication";

interface Props { params: Promise<{ id: string; matterId: string; executionId: string }>; searchParams: Promise<{ publicationId?: string | string[] }> }

export default function ApprovedDrivePublicationPage({ params, searchParams }: Props) {
  const { id, matterId, executionId } = use(params);
  const query = use(searchParams);
  const rawPublicationId = query.publicationId;
  const publicationId = Array.isArray(rawPublicationId) ? "__duplicate_publication_id__" : rawPublicationId;
  return <ApprovedDrivePublication key={`${id}:${matterId}:${executionId}:${publicationId ?? "none"}`} projectId={id} matterId={matterId} executionId={executionId} publicationId={publicationId ?? null} />;
}
