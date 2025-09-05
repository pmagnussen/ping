namespace Ping.Server.Models
{
    public static class PingPermissions
    {
        // Voice chat permissions
        public const string VoiceChat_Join = "voicechat.join";
        public const string VoiceChat_Speak = "voicechat.speak";
        public const string VoiceChat_Listen = "voicechat.listen";
        public const string VoiceChat_Moderate = "voicechat.moderate";
        
        // Chat permissions
        public const string Chat_Send = "chat.send";
        public const string Chat_Read = "chat.read";
        public const string Chat_Delete = "chat.delete";
        public const string Chat_Moderate = "chat.moderate";
        
        // Admin permissions
        public const string Admin_ManageUsers = "admin.manage_users";
        public const string Admin_ViewLogs = "admin.view_logs";
        public const string Admin_SystemConfig = "admin.system_config";
        
        // Get all permissions
        public static readonly string[] All = {
            VoiceChat_Join, VoiceChat_Speak, VoiceChat_Listen, VoiceChat_Moderate,
            Chat_Send, Chat_Read, Chat_Delete, Chat_Moderate,
            Admin_ManageUsers, Admin_ViewLogs, Admin_SystemConfig
        };
        
        // Role-based default permissions
        public static readonly Dictionary<UserRole, string[]> RolePermissions = new()
        {
            [UserRole.User] = new[] {
                VoiceChat_Join, VoiceChat_Speak, VoiceChat_Listen,
                Chat_Send, Chat_Read
            },
            [UserRole.Moderator] = new[] {
                VoiceChat_Join, VoiceChat_Speak, VoiceChat_Listen, VoiceChat_Moderate,
                Chat_Send, Chat_Read, Chat_Delete, Chat_Moderate
            },
            [UserRole.Admin] = new[] {
                VoiceChat_Join, VoiceChat_Speak, VoiceChat_Listen, VoiceChat_Moderate,
                Chat_Send, Chat_Read, Chat_Delete, Chat_Moderate,
                Admin_ManageUsers, Admin_ViewLogs
            },
            [UserRole.SuperAdmin] = All
        };
    }
}
