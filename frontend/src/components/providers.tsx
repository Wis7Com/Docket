"use client";

import { AuthProvider } from "@/contexts/AuthContext";
import { UserProfileProvider } from "@/contexts/UserProfileContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AnnotationColorPaletteProvider } from "@/contexts/AnnotationColorPaletteContext";
import { MainRouteListener } from "@/components/main-route-listener";
import { CtrlZoomListener } from "@/components/ctrl-zoom-listener";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <ThemeProvider>
            <AnnotationColorPaletteProvider>
                <AuthProvider>
                    <UserProfileProvider>
                        <MainRouteListener />
                        <CtrlZoomListener />
                        {children}
                    </UserProfileProvider>
                </AuthProvider>
            </AnnotationColorPaletteProvider>
        </ThemeProvider>
    );
}
