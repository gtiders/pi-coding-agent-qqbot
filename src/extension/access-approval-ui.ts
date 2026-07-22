import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export async function confirmAdminApproval(context: ExtensionContext, maskedUser: string): Promise<boolean> {
	if (!context.hasUI) return false;
	return context.ui.confirm("授予 QQ 管理员权限？", `用户 ${maskedUser} 将能够管理 QQ 会话。`);
}
