/**
 * UI primitive barrel.
 *
 * Everything the app renders comes from here. Two rules the components enforce and the
 * screens must not work around:
 *
 *   • No raw hex anywhere — colours come from `useTheme().colors`.
 *   • No literal strings in JSX — every user-facing word comes through `t()`.
 *
 * `Alert.alert` and `confirm()` are never used; `useConfirm` replaces both.
 */

export { Banner } from './Banner';
export type { BannerProps, BannerVariant } from './Banner';

export { BigButtonGrid } from './BigButtonGrid';
export type { BigButtonGridProps, BigButtonItem } from './BigButtonGrid';

export { Button } from './Button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button';

export { Card } from './Card';
export type { CardProps } from './Card';

export { Chip } from './Chip';
export type { ChipProps } from './Chip';

export { Dialog } from './Dialog';
export type { DialogProps } from './Dialog';

export { Divider, ROW_DIVIDER_INSET } from './Divider';
export type { DividerProps } from './Divider';

export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';

export { Icon } from './Icon';
export type { IconName, IconProps } from './Icon';

export { ListRow } from './ListRow';
export type { ListRowProps } from './ListRow';

export { NumberPad } from './NumberPad';
export type { NumberPadField, NumberPadProps } from './NumberPad';

export { PressableScale } from './PressableScale';
export type { PressableScaleProps } from './PressableScale';

export { ReadBackDialog } from './ReadBackDialog';
export type { ReadBackDialogProps } from './ReadBackDialog';

export { Screen } from './Screen';
export type { ScreenProps } from './Screen';

export { ScreenHeader } from './ScreenHeader';
export type { ScreenHeaderProps } from './ScreenHeader';

export { SectionHeader } from './SectionHeader';
export type { SectionHeaderProps } from './SectionHeader';

export { Skeleton } from './Skeleton';
export type { SkeletonProps } from './Skeleton';

export { StatCard } from './StatCard';
export type { StatCardProps, StatRange } from './StatCard';

export { Text } from './Text';
export type { TextProps, TextTone, TextVariant } from './Text';

export { TextField } from './TextField';
export type { TextFieldProps } from './TextField';

export { ToastProvider, useToast } from './Toast';
export type { ToastApi, ToastOptions, ToastVariant } from './Toast';

export { ConfirmProvider, useConfirm } from './useConfirm';
export type { ConfirmFn, ConfirmOptions } from './useConfirm';
