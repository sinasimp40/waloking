# Plan - Modern Apple-Style Admin Login Redesign

Redesign the Balok admin login popup to follow a modern macOS-inspired aesthetic, using deep glassmorphism and the application's accent color.

## User Review Required

> [!IMPORTANT]
> The redesign will shift from a standard boxed modal to a more refined glassmorphic surface with subtle blurs and shadows, consistent with modern "Modern Clean" UI standards.

- Do you have a preferred blur intensity for the "glass" effect (e.g., subtle vs. heavy)?
- Should the accent color be used as the primary background for the login button, or just as an outline/focus element?

## Proposed Changes

### UI & Styling

#### `src/balok/components/AdminLogin.jsx`
- Replace `bg-slate-900` with a semi-transparent `bg-zinc-950/60` and `backdrop-blur-xl`.
- Apply `shadow-2xl` and a refined `border-zinc-800/50`.
- Update the icon container to use the dynamic `accent` color with a low-opacity background.
- Style the input field to have a subtle `bg-zinc-950/40` and a focus ring matching the `accent` color.
- Update the login button to use a solid `accent` color background with a hover effect.
- Use `Plus Jakarta Sans` for the heading and `Inter` for supporting text.
- Ensure the "Cancel" button and "Invalid credentials" text align with the new theme.

## Technical Details

- **Accent Color Integration**: Use the `accent` variable retrieved from the store to dynamically style the UI elements.
- **Glassmorphism**: Utilize Tailwind's `backdrop-blur` and high-opacity backgrounds.
- **Typography**: Leverage existing project fonts for a premium look.
