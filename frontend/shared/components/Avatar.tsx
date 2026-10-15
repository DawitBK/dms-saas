import { cn } from "@/shared/lib/cn";

const COLORS = [
  'bg-blue-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-pink-500',
  'bg-purple-500',
  'bg-cyan-500',
  'bg-red-500',
  'bg-violet-500'
];

interface AvatarProps {
  firstName?: string;
  lastName?: string;
  email?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export const Avatar = ({
  firstName,
  lastName,
  email,
  size = 'md',
  className
}: AvatarProps) => {
  let initials = '??';
  if (firstName && lastName) {
    initials = `${firstName[0]}${lastName[0]}`.toUpperCase();
  } else if (email) {
    initials = email[0].toUpperCase();
  }

  const hash = (initials.charCodeAt(0) || 0) + (initials.charCodeAt(1) || 0);
  const colorClass = COLORS[hash % COLORS.length];

  const sizeClasses = {
    sm: 'h-8 w-8 text-xs',
    md: 'h-10 w-10 text-sm',
    lg: 'h-12 w-12 text-base'
  };

  return (
    <div
      className={cn(
        'inline-flex items-center justify-center rounded-full font-semibold text-white',
        sizeClasses[size],
        colorClass,
        className
      )}
    >
      {initials}
    </div>
  );
};
