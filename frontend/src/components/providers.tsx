"use client";

import { AuthProvider } from "@/contexts/AuthContext";
import { UserProfileProvider } from "@/contexts/UserProfileContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AnnotationColorPaletteProvider } from "@/contexts/AnnotationColorPaletteContext";
import { MainRouteListener } from "@/components/main-route-listener";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <ThemeProvider>
            <AnnotationColorPaletteProvider>
                <AuthProvider>
                    <UserProfileProvider>
                        <MainRouteListener />
                        {children}
                    </UserProfileProvider>
                </AuthProvider>
            </AnnotationColorPaletteProvider>
        </ThemeProvider>
    );
}
