/** The round button on the brand band (back, help, preferences). Its own module so the public product header can use it without pulling the in-app header (login, notifications) into its bundle. */
export const bandButton =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-background text-foreground/80 shadow-sm ring-1 ring-foreground/10 transition-colors hover:text-primary";
