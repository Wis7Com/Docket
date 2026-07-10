"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";

export default function LoginPage() {
  const router = useRouter();
  const { authLoading } = useAuth();

  useEffect(() => {
    if (!authLoading) {
      router.replace("/projects");
    }
  }, [authLoading, router]);

  return null;
}
