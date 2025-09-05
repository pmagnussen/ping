using Microsoft.EntityFrameworkCore;
using Ping.Server.Models;
using System.Text.Json;

namespace Ping.Server.Data
{
    public class ApplicationDbContext : DbContext
    {
        public ApplicationDbContext(DbContextOptions<ApplicationDbContext> options) : base(options)
        {
        }

        public DbSet<ApplicationUser> Users { get; set; }
        public DbSet<UserPermission> UserPermissions { get; set; }
        public DbSet<MagicLinkToken> MagicLinkTokens { get; set; }
        public DbSet<VerificationCode> VerificationCodes { get; set; }

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            base.OnModelCreating(modelBuilder);

            modelBuilder.Entity<ApplicationUser>(entity =>
            {
                entity.HasKey(e => e.Id);
                entity.HasIndex(e => e.Email).IsUnique();
                entity.Property(e => e.Email).IsRequired();
                entity.Property(e => e.Role).HasConversion<int>();
                
                // Store permissions as JSON
                entity.Property(e => e.Permissions)
                    .HasConversion(
                        v => JsonSerializer.Serialize(v, (JsonSerializerOptions)null!),
                        v => JsonSerializer.Deserialize<List<string>>(v, (JsonSerializerOptions)null!) ?? new List<string>());
            });

            modelBuilder.Entity<UserPermission>(entity =>
            {
                entity.HasKey(e => e.Id);
                entity.HasIndex(e => new { e.UserId, e.Permission }).IsUnique();
                entity.Property(e => e.Permission).IsRequired();
                
                entity.HasOne(e => e.User)
                    .WithMany(e => e.UserPermissions)
                    .HasForeignKey(e => e.UserId)
                    .OnDelete(DeleteBehavior.Cascade);
            });

            modelBuilder.Entity<MagicLinkToken>(entity =>
            {
                entity.HasKey(e => e.Id);
                entity.HasIndex(e => e.Token).IsUnique();
                entity.Property(e => e.Email).IsRequired();
                entity.Property(e => e.Token).IsRequired();
            });

            modelBuilder.Entity<VerificationCode>(entity =>
            {
                entity.HasKey(e => e.Id);
                entity.HasIndex(e => new { e.Email, e.Code });
                entity.Property(e => e.Email).IsRequired();
                entity.Property(e => e.Code).IsRequired().HasMaxLength(6);
            });
        }
    }
}
