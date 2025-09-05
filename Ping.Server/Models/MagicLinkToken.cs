namespace Ping.Server.Models
{
    public class MagicLinkToken
    {
        public string Id { get; set; } = Guid.NewGuid().ToString();
        public string Email { get; set; } = string.Empty;
        public string Token { get; set; } = string.Empty;
        public DateTime ExpiresAt { get; set; }
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
        public bool IsUsed { get; set; } = false;
    }
}
