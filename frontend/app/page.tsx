"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "../state/auth.store";

export default function Home() {
  const router = useRouter();
  const { accessToken, userId, hydrated } = useAuthStore();

  useEffect(() => {
    if (!hydrated) {
      const timer = setTimeout(() => {
        router.replace('/login');
      }, 500);
      return () => clearTimeout(timer);
    }
    if (accessToken && userId) router.replace("/dashboard");
    else router.replace("/login");
  }, [hydrated, accessToken, userId, router]);

  return (
    <div className="flex flex-1 items-center justify-center min-h-screen">
      <div className="h-10 w-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
